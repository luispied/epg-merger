import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aptTitles, decodeEntities, filterGuide, KidsGuide, titleKey } from '../src/guide-kids.ts';
import { parseKids } from '../src/kids.ts';

const programme = (channel: string, title: string, desc = '') =>
  `  <programme start="20261013100000 +0000" stop="20261013103000 +0000" channel="${channel}">\n` +
  `    <title lang="es">${title}</title>\n` +
  (desc ? `    <desc lang="es">${desc}</desc>\n` : '') +
  `  </programme>\n`;

const guide = `<?xml version="1.0" encoding="UTF-8" ?>\n<tv>\n` +
  `  <channel id="c1"><display-name>Canal</display-name></channel>\n` +
  programme('c1', 'Bob &amp; Ana', 'dibujos') +
  programme('c1', 'Noticias &lt;hoy&gt;', 'informativo') +
  programme('c1', 'Sin género') +
  programme('c1', 'Publicidad') +
  `</tv>\n`;

const apt = new Set([titleKey('Bob & Ana'), titleKey('Pancho  Panza')]);

test('KidsGuide: deja los programas aptos y saca los demás, con el resto del XML', () => {
  const out = new KidsGuide(apt);
  const text = out.push(guide) + out.end();
  assert.ok(text.includes('Bob &amp; Ana'));
  assert.ok(!text.includes('Noticias'));
  assert.ok(!text.includes('Sin género'));
  assert.ok(!text.includes('Publicidad'));
  assert.ok(text.includes('<channel id="c1">'));
  assert.ok(text.startsWith('<?xml'));
  assert.ok(text.trimEnd().endsWith('</tv>'));
});

test('KidsGuide: da lo mismo cortado en trozos de cualquier tamaño', () => {
  const whole = new KidsGuide(apt);
  const expected = whole.push(guide) + whole.end();
  for (const size of [1, 2, 7, 13, 50]) {
    const g = new KidsGuide(apt);
    let got = '';
    for (let i = 0; i < guide.length; i += size) got += g.push(guide.slice(i, i + size));
    got += g.end();
    assert.equal(got, expected, `trozos de ${size}`);
  }
});

test('KidsGuide: un programa sin cerrar no sale nunca', () => {
  const g = new KidsGuide(apt);
  const text = g.push(programme('c1', 'Bob &amp; Ana').slice(0, 40)) + g.end();
  assert.ok(!text.includes('<programme') && !text.includes('Bob'));
});

test('decodeEntities: las entidades comunes y numéricas, una sola pasada', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), 'a & b <c> "d" \'e\'');
  assert.equal(decodeEntities('&#233;&#xE9;'), 'éé');
  assert.equal(decodeEntities('&amp;amp;'), '&amp;');
  assert.equal(decodeEntities('&#x110000; &nada;'), '&#x110000; &nada;');
});

test('titleKey: igual que la clave del índice (espacios juntos, minúsculas)', () => {
  assert.equal(titleKey('  Pancho   PANZA '), 'pancho panza');
});

/** Un R2 de prueba con el índice de temas (sin comprimir). */
function bucketWith(topics: unknown): Parameters<typeof aptTitles>[0] {
  const bytes = new TextEncoder().encode(JSON.stringify(topics));
  return {
    get: async (key: string) => (key === 'ui/schedule/topics.json'
      ? { httpMetadata: {}, arrayBuffer: async () => bytes.buffer.slice(0) }
      : null),
  } as unknown as Parameters<typeof aptTitles>[0];
}

test('aptTitles: solo los títulos con un género apto para el perfil', async () => {
  const kids = parseKids({ genres: ['Cocina'] })!;
  const bucket = bucketWith({
    g: ['Infantil', 'Película', 'Cocina'],
    t: ['bob & ana', 'película grande', 'pancho panza', 'sin género'],
    r: [[0], [1], [2, 5], [-1, 3]],
  });
  const set = await aptTitles(bucket, kids);
  assert.deepEqual([...set].sort(), ['bob & ana', 'pancho panza']);
});

test('aptTitles: sin índice, nada es apto (lo seguro)', async () => {
  const none = { get: async () => null } as unknown as Parameters<typeof aptTitles>[0];
  assert.equal((await aptTitles(none, parseKids({})!)).size, 0);
});

test('filterGuide: el gzip de entrada sale filtrado y vuelve a ser gzip', async () => {
  const gz = new Response(new Blob([guide]).stream().pipeThrough(new CompressionStream('gzip'))).body!;
  const out = filterGuide(gz, apt);
  const text = await new Response(out.pipeThrough(new DecompressionStream('gzip'))).text();
  assert.ok(text.includes('Bob &amp; Ana'));
  assert.ok(!text.includes('Noticias') && !text.includes('Publicidad'));
});
