// Hora de comienzo de los eventos (PPV) que algunos proveedores ponen en el nombre del canal.
// La hora es la de la zona del proveedor: se convierte a la del dispositivo. Los formatos que se
// reconocen son pocos y concretos; si un nombre no coincide con ninguno, no se toca.

export interface EventTime {
  /** Comienzo, en milisegundos desde 1970 (UTC). */
  start: number;
  /** El nombre sin la fecha y la hora (queda el evento, la liga y el canal que lo emite). */
  clean: string;
}

/** Desfase (ms) de una zona respecto de UTC en un instante dado. */
function zoneOffset(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** La hora de pared `y-m-d h:mi` en la zona `tz`, como instante UTC. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - zoneOffset(guess, tz);
  t = guess - zoneOffset(t, tz); // por si el desfase cambia justo ahí (horario de verano)
  return t;
}

/** Año, mes y día de un instante en la zona `tz`. */
function zonedDate(ms: number, tz: string): { y: number; m: number; d: number } {
  const o = ms + zoneOffset(ms, tz);
  const dt = new Date(o);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const hour24 = (h: number, ap?: string) => {
  if (!ap) return h;
  const pm = ap.toLowerCase() === 'pm';
  return (h % 12) + (pm ? 12 : 0);
};
const tidy = (s: string) => s.replace(/\s*\*+\s*$/, '').replace(/\s+/g, ' ').trim();
const join = (...parts: (string | undefined)[]) => parts.map((p) => tidy(p ?? '')).filter(Boolean).join(' · ');

interface Raw { date?: { m: number; d: number }; h: number; mi: number; clean: string }

/** Reconoce los formatos conocidos; devuelve fecha (si la trae), hora y el nombre limpio. */
function match(name: string): Raw | null {
  const n = name.trim();
  let m: RegExpMatchArray | null;
  // 11:00  Belarus vs. San Marino  UEFA Nations League
  if ((m = n.match(/^(\d{1,2}):(\d{2})\s{2,}(.+?)(?:\s{2,}(.+))?$/))) return { h: +m[1], mi: +m[2], clean: join(m[3], m[4]) };
  // 08:00 - League Two - Crewe Alexandra vs. Bristol Rovers
  if ((m = n.match(/^(\d{1,2}):(\d{2}) - (.+)$/))) {
    const [a, b, ...rest] = m[3].split(' - ');
    return { h: +m[1], mi: +m[2], clean: b === undefined ? tidy(a) : join(b, ...rest, a) };
  }
  // 10/03 NCAAF 12:00pm Assumption vs Bentley = CBS USA ***   (mes/día)
  if ((m = n.match(/^(\d{1,2})\/(\d{1,2}) (\S+) (\d{1,2}):(\d{2})\s?([ap]m) (.+?)(?: = (.+))?$/i))) {
    return { date: { m: +m[1], d: +m[2] }, h: hour24(+m[4], m[6]), mi: +m[5], clean: join(m[7], m[3], m[8]) };
  }
  // Soccer 03/10 09:00am - Paris Saint-Germain vs Toulouse FC: French Ligue 1   (día/mes)
  if ((m = n.match(/^(\S+) (\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})\s?([ap]m) - (.+)$/i))) {
    return { date: { m: +m[3], d: +m[2] }, h: hour24(+m[4], m[6]), mi: +m[5], clean: join(m[7], m[1]) };
  }
  // PPV  016 || 03/10 18:00 | PBR | Rattler Days - Nights 2   (día/mes)
  if ((m = n.match(/^PPV\s+\d+\s*\|\|\s*(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}) \| (.+)$/))) {
    return { date: { m: +m[2], d: +m[1] }, h: +m[3], mi: +m[4], clean: join(...m[5].split(' | ')) };
  }
  // 003 MX: Liga Femenil / Leon vs Tigres - 7:05PM - Purple 3
  if ((m = n.match(/^(.+?) - (\d{1,2}):(\d{2})\s?([AP]M) - (.+)$/i))) {
    return { h: hour24(+m[2], m[4]), mi: +m[3], clean: join(m[1].replace(/^\d{1,3}\s+/, ''), m[5]) };
  }
  // [CONCACAF Nations League] Dominica vs Guyana - 15:00
  if ((m = n.match(/^\[(.+?)\]\s*(.+) - (\d{1,2}):(\d{2})$/))) return { h: +m[3], mi: +m[4], clean: join(m[2], m[1]) };
  return null;
}

const DAY = 86400000;

/** La hora de comienzo del evento que dice el nombre, o null si no trae una que se entienda.
 *  Sin fecha, se toma el día (en la zona del proveedor) en que cae más cerca de `now`. */
export function parseEvent(name: string, tz: string, now: number): EventTime | null {
  if (!/\d:\d\d/.test(name)) return null;
  const r = match(name);
  if (!r || r.h > 23 || r.mi > 59) return null;
  const today = zonedDate(now, tz);
  let start: number;
  if (r.date) {
    if (r.date.m < 1 || r.date.m > 12 || r.date.d < 1 || r.date.d > 31) return null;
    start = zonedToUtc(today.y, r.date.m, r.date.d, r.h, r.mi, tz);
    // Cerca de fin de año, «01/01» es del año que viene (o «12/31» del anterior).
    if (start - now > 182 * DAY) start = zonedToUtc(today.y - 1, r.date.m, r.date.d, r.h, r.mi, tz);
    else if (now - start > 182 * DAY) start = zonedToUtc(today.y + 1, r.date.m, r.date.d, r.h, r.mi, tz);
  } else {
    const base = zonedToUtc(today.y, today.m, today.d, r.h, r.mi, tz);
    start = [base - DAY, base, base + DAY].reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
  }
  return { start, clean: r.clean || name.trim() };
}
