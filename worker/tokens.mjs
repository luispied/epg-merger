// Lo usa build.mjs para armar public/app.css a partir de web/tokens.css (y lo prueba test/tokens.test.ts).

/** tokens.css escribe cada token que cambia con el tema una sola vez, como `--x: light-dark(claro, oscuro);`. Acá se
 *  expande en los bloques de siempre: el claro queda en :root y el oscuro va dos veces, con el sistema en oscuro (salvo
 *  que se haya elegido el tema claro) y con el tema oscuro elegido. Así sirve para cualquier valor (sombras incluidas) y
 *  en cualquier navegador. */
export function expandTokens(src) {
  const dark = [];
  const out = src.replace(/(--[\w-]+)\s*:\s*light-dark\(([^;]*)\)\s*;/g, (all, name, args) => {
    const [light, darkValue] = splitLightDark(args);
    dark.push(`${name}: ${darkValue};`);
    return `${name}: ${light};`;
  });
  if (!dark.length) return out;
  const block = (pad) => dark.map((d) => `${pad}${d}`).join('\n');
  return `${out}\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${block('    ')}\n  }\n}\n:root[data-theme="dark"] {\n${block('  ')}\n}\n`;
}

/** Los dos valores de light-dark(claro, oscuro): se corta en la primera coma fuera de paréntesis. Un valor con comas
 *  propias (una sombra de varias capas) separa el claro del oscuro con ` | ` en lugar de la coma. */
function splitLightDark(args) {
  const bar = args.indexOf(' | ');
  if (bar >= 0) return [args.slice(0, bar).trim(), args.slice(bar + 3).trim()];
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) return [args.slice(0, i).trim(), args.slice(i + 1).trim()];
  }
  throw new Error(`light-dark() sin dos valores: ${args}`);
}
