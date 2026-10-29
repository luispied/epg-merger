// Piezas comunes de la interfaz (auditoría de diseño, paso 3b). Las pantallas las usan en vez de armar el mismo marcado
// cada una: así se ven y se comportan igual en todos lados.
import { useEffect, useState } from 'preact/hooks';

/** Barra de cuánto va (0 a 100). `cls` elige el tamaño de la pantalla (np-bar: fila y hoja; vw-bar: modo ver; rv-bar:
 *  revisión). Con `label` es una barra de progreso para el lector de pantalla; sin, es decorativa (el texto de al lado ya
 *  dice cuánto queda). */
export function Progress({ value, cls, label }: { value: number; cls: string; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const bar = <i style={{ width: `${pct}%` }} />;
  return label
    ? <div class={cls} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>{bar}</div>
    : <span class={cls} aria-hidden="true">{bar}</span>;
}

/** La marca al pie (Configuración y modo ver): ícono y wordmark chicos. Las pestañas llevan su título, no la marca; en
 *  el escritorio el ícono va arriba de la barra lateral. */
export function BrandFoot() {
  return (
    <div class="brand-foot">
      <img src="img/icon.svg" alt="" width="28" height="28" />
      <span class="wordmark"><span aria-hidden="true">nowl<span class="wm-i">ı</span>ne</span><span class="sr-only">nowline</span></span>
    </div>
  );
}

/** Alto mínimo de una tarjeta del esqueleto (con su separación): con menos no alcanza a cubrir la pantalla. */
const SKEL_ROW = 150;

/** Cuántas tarjetas hacen falta para cubrir el alto de la pantalla (y un poco más, así no queda hueco al bajar). */
const skelRows = () => Math.ceil(window.innerHeight / SKEL_ROW) + 1;

/** Mientras cargan las tarjetas de canales: el mismo esqueleto en la edición y en el modo ver (sin texto de carga). Se
 *  arma según el alto de la pantalla y se rehace al girar o cambiar el tamaño; `rows` fija cuántas (para dentro de una hoja). */
export function Skeleton({ rows: fixed }: { rows?: number } = {}) {
  const [auto, setRows] = useState(skelRows);
  const rows = fixed ?? auto;
  useEffect(() => {
    if (fixed !== undefined) return;
    const resize = () => setRows(skelRows());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [fixed]);
  return (
    <>
      {Array.from({ length: rows }, (_, k) => <div key={k} class="skeleton"><div class="bar w60" /><div class="bar w40" /><div class="bar block" /></div>)}
    </>
  );
}

/** Ítems que se ven en la franja [vt, vb), con `margin` px de más arriba y abajo. `offs[k]` es el comienzo del ítem `k` y
 *  `offs[n]` el total: devuelve [a, b), sin incluir b. Lo usan la Guía y la lista de Canales (alturas fijas, sin medir). */
export function rangeOf(offs: number[], vt: number, vb: number, margin: number): [number, number] {
  const n = offs.length - 1;
  let a = 0;
  while (a < n - 1 && offs[a + 1] <= vt - margin) a++;
  let b = a + 1;
  while (b < n && offs[b] < vb + margin) b++;
  return [a, b];
}

/** Las últimas 24 horas de conexiones en uso: una barra por hora, de la más vieja a la actual. La hora actual va en verde
 *  sólido; las demás horas con conexiones, en verde suave. Sin datos, la barra es un tramo chico del fondo. */
export function HourBars({ hours, max, label }: { hours: (number | null)[]; max: number; label: string }) {
  return (
    <div class="hour-bars" role="img" aria-label={label}>
      {hours.map((n, i) => (
        <i
          key={i}
          class={`${n ? 'on' : ''}${i === hours.length - 1 ? ' cur' : ''}`}
          style={{ height: `${n ? Math.max(8, Math.round((n / max) * 100)) : 4}%` }}
        />
      ))}
    </div>
  );
}
