import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { handle } from '../src/index.ts';
import { gunzip } from '../src/schedule.ts';
import { makeEnv } from './helpers.ts';

const file = (id: string) => createHash('sha1').update(id).digest('hex').slice(0, 16);
const req = (path: string) => new Request(`https://w.test${path}`);

/** Una tanda como la arma tools/pack_schedule.py. */
function shard(channels: Record<string, unknown>): Uint8Array {
  const index: Record<string, [number, number]> = {};
  const parts: Buffer[] = [];
  let at = 0;
  for (const [f, entries] of Object.entries(channels)) {
    const gz = gzipSync(JSON.stringify(entries));
    index[f] = [at, gz.length];
    parts.push(gz);
    at += gz.length;
  }
  const header = Buffer.from(JSON.stringify(index));
  return Buffer.concat([Buffer.from(String(header.length).padStart(8, '0')), header, ...parts]);
}

test('programación en tandas: cada canal viaja en gzip, con dos lecturas por rango', async () => {
  const t = makeEnv();
  const now = Math.floor(Date.now() / 1000);
  const plot = 'Un detective retirado vuelve para un último caso en su ciudad natal.';
  const a = 'g0123456789abcd.uy';
  const fa = file(a);
  // Otro canal en la misma tanda, para que las posiciones no empiecen en cero.
  const other = `${fa.slice(0, 2)}${'0'.repeat(14)}`;
  const entries = [[now - 1800, now + 3600, 'Peli', plot], [now + 7200, now + 12600, 'Peli', plot]];
  await t.env.BUCKET.put(`ui/schedule/s/${fa.slice(0, 2)}`, shard({ [other]: [[1, 2, 'Otra']], [fa]: entries }));

  const res = await handle(req(`/api/ui/schedule/${fa}.json`), t.env, t.ctx, t.cache);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Encoding'), 'gzip');
  assert.deepEqual(JSON.parse(await gunzip(new Uint8Array(await res.arrayBuffer()))), entries);
  assert.equal((await handle(req(`/api/ui/schedule/${fa.slice(0, 2)}${'f'.repeat(14)}.json`), t.env, t.ctx, t.cache)).status, 404);
  assert.equal((await handle(req('/api/ui/schedule/s/00.json'), t.env, t.ctx, t.cache)).status, 404);

  // «Llegás desde el principio» lee de la misma tanda.
  const again = await handle(new Request('https://w.test/api/ui/again', { method: 'POST', body: JSON.stringify({ ids: [a] }) }), t.env, t.ctx, t.cache);
  assert.deepEqual((await again.json() as { r: unknown[] }).r, [[0, now - 1800, [[0, now + 7200]]]]);
});

test('índice por hora: el guardado en gzip viaja tal cual, el viejo en texto también', async () => {
  const t = makeEnv();
  const body = '{"h":1,"t":[],"c":{}}';
  await t.env.BUCKET.put('ui/schedule/hour/2026101119.json', gzipSync(body), { httpMetadata: { contentEncoding: 'gzip' } });
  const gz = await handle(req('/api/ui/schedule/hour/2026101119.json'), t.env, t.ctx, t.cache);
  assert.equal(gz.headers.get('Content-Encoding'), 'gzip');
  assert.equal(await gunzip(new Uint8Array(await gz.arrayBuffer())), body);
  await t.env.BUCKET.put('ui/schedule/hour/2026101120-d.json', body);
  const plain = await handle(req('/api/ui/schedule/hour/2026101120-d.json'), t.env, t.ctx, t.cache);
  assert.equal(plain.headers.get('Content-Encoding'), null);
  assert.equal(await plain.text(), body);
  assert.equal((await handle(req('/api/ui/schedule/hour/x.json'), t.env, t.ctx, t.cache)).status, 404);
});
