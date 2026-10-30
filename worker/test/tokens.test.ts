import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { expandTokens } from '../tokens.mjs';

test('tokens: light-dark() se expande en el claro y en los dos bloques del oscuro', () => {
  const css = expandTokens(':root {\n  --bg: light-dark(#fff, #000);\n  --toolbar: light-dark(rgba(1, 2, 3, .9), rgba(4, 5, 6, .9));\n'
    + '  --shadow: light-dark(0 1px 2px rgba(0, 0, 0, .1), 0 0 1px red | 0 2px 4px black);\n  --radius: 14px;\n}\n');
  assert.match(css, /:root \{\n {2}--bg: #fff;\n {2}--toolbar: rgba\(1, 2, 3, \.9\);\n {2}--shadow: 0 1px 2px rgba\(0, 0, 0, \.1\), 0 0 1px red;\n {2}--radius: 14px;\n\}/);
  const dark = '  --bg: #000;\n  --toolbar: rgba(4, 5, 6, .9);\n  --shadow: 0 2px 4px black;';
  assert.ok(css.includes(`@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n  ${dark.replaceAll('\n', '\n  ')}\n  }\n}`));
  assert.ok(css.includes(`:root[data-theme="dark"] {\n${dark}\n}`));
  assert.doesNotMatch(css, /light-dark/);
  assert.equal(expandTokens(':root { --a: 1px; }'), ':root { --a: 1px; }');
  assert.throws(() => expandTokens(':root { --a: light-dark(#fff); }'), /sin dos valores/);
});

test('tokens: web/tokens.css es el único lugar que define los tokens de :root', () => {
  const tokens = expandTokens(readFileSync(new URL('../web/tokens.css', import.meta.url), 'utf-8'));
  assert.doesNotMatch(tokens, /:\s*light-dark\(/);
  for (const f of ['base.css', 'web.css']) {
    const css = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf-8');
    assert.doesNotMatch(css, /:root(?::not\(\[data-theme="(?:light|dark)"\]\)|\[data-theme="dark"\])?\s*\{[^{}]*--/, `${f} define tokens en :root`);
  }
});

test('tokens: base.css y web.css piden colores a los tokens y no escriben el tema oscuro aparte', () => {
  for (const f of ['base.css', 'web.css']) {
    const css = readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    // Un color fijo (#abc o rgba()) va en tokens.css, con su claro y su oscuro; acá solo var(--…).
    assert.deepEqual(css.match(/#[0-9a-f]{3,8}\b/gi) ?? [], [], `${f} tiene colores fijos`);
    assert.deepEqual(css.match(/rgba?\(/g) ?? [], [], `${f} tiene rgba() fuera de tokens.css`);
    // El oscuro de cada color lo resuelve tokens.css: nada de reglas propias para [data-theme] o el sistema en oscuro.
    assert.doesNotMatch(css, /data-theme|prefers-color-scheme/, `${f} escribe el tema oscuro aparte`);
  }
});
