// Dónde va una categoría nueva del proveedor: junto a las que ya tiene con el mismo comienzo de
// nombre ("PPV FUTBOL LALIGA" después de "PPV FUTBOL PREMIER"), y si no se parece a ninguna, al
// final. Lo usan la playlist del Worker y la web, para que se vea igual en las dos.

/** Separadores de sección del proveedor (▆░▒▓█): no sirven para decidir a qué familia pertenece. */
const HEADER = /[▀-▟]{2,}/;

const tokens = (g: string) => g.normalize('NFKD').replace(/\p{Mn}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function sharedPrefix(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** `order`: el orden guardado (puede traer categorías que hoy no están). `present`: las de la lista
 *  actual, en el orden del proveedor. Devuelve `order` con las que faltaban ya ubicadas. Sin orden
 *  guardado se respeta el del proveedor. `skip`: categorías que no cuentan como familia (los
 *  separadores propios). */
export function placeNewGroups(order: string[], present: string[], skip: ReadonlySet<string> = new Set()): string[] {
  if (!order.length) return [...present];
  const known = new Set(order);
  const list = [...order];
  for (const g of present) {
    if (known.has(g)) continue;
    known.add(g);
    const mine = tokens(g);
    let best = 0;
    let at = -1;
    list.forEach((h, i) => {
      if (HEADER.test(h) || skip.has(h)) return;
      const s = sharedPrefix(mine, tokens(h));
      if (s === 0 || s < best) return;
      best = s;
      at = i; // entre las que más se parecen, la última: se agrega al final de su familia
    });
    if (at < 0) list.push(g);
    else list.splice(at + 1, 0, g);
  }
  return list;
}
