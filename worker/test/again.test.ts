import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { findAgain } from '../src/again.ts';
import { handle } from '../src/index.ts';
import { makeEnv } from './helpers.ts';

const NOW = 1_800_000_000;
const M = 60;

test('llegás desde el principio: misma película más tarde, en el mismo canal o en otro', () => {
  const hbo = [
    [NOW - 40 * M, NOW + 70 * M, 'Rain Man', 'Dos hermanos se reencuentran después de la muerte del padre.'],
    [NOW + 70 * M, NOW + 180 * M, 'Otra'],
    [NOW + 180 * M, NOW + 290 * M, 'Rain Man', 'Dos hermanos se reencuentran después de la muerte del padre.'],
  ] as [number, number, string, string?][];
  const hbo2 = [[NOW + 30 * M, NOW + 140 * M, 'Rain  Man', 'Dos hermanos se reencuentran después de la muerte del padre.']] as [number, number, string, string][];
  const r = findAgain([hbo, hbo2], NOW);
  assert.deepEqual(r.find(([i, s]) => i === 0 && s === NOW - 40 * M), [0, NOW - 40 * M, [[1, NOW + 30 * M], [0, NOW + 180 * M]]]);
});

test('no cuenta como repetición: capítulos distintos, duraciones distintas, relleno ni títulos genéricos', () => {
  const axn = [
    [NOW - 30 * M, NOW + 24 * M, 'Imborrable (T2)', 'Capítulo 1.'],
    [NOW + 24 * M, NOW + 78 * M, 'Imborrable (T2)', 'Capítulo 2.'],
    [NOW + 78 * M, NOW + 132 * M, 'Imborrable (T2)'],         // sin descripción y pegado: el siguiente
    [NOW - 30 * M, NOW, 'Ya terminó'],
    [NOW + 200 * M, NOW + 247 * M, 'Joyas sobre ruedas', 'Mike y Edd compran y arreglan autos para venderlos.'],
    [NOW + 247 * M, NOW + 294 * M, 'Joyas sobre ruedas', 'Mike y Edd compran y arreglan autos para venderlos.'], // misma sinopsis, en tanda
  ] as [number, number, string, string?][];
  const espn = [
    [NOW - 20 * M, NOW + 40 * M, 'Partido'],
    [NOW + 120 * M, NOW + 300 * M, 'Partido'],                // dura otra cosa
    [NOW - 20 * M, NOW + 70 * M, 'Eredivisie', 'Fútbol'], [NOW + 150 * M, NOW + 240 * M, 'Eredivisie', 'Fútbol'], // sinopsis que no dice nada
    ...[0, 1, 2, 3, 4].map((k) => [NOW + (300 + k * 60) * M, NOW + (330 + k * 60) * M, 'SportsCenter']),
    [NOW, NOW + 60 * M, 'Paid Programming'], [NOW + 60 * M, NOW + 120 * M, 'Paid Programming'],
  ] as [number, number, string][];
  assert.deepEqual(findAgain([axn, espn], NOW), []);
});

test('POST /api/ui/again lee la programación de cada canal y guarda la respuesta', async () => {
  const t = makeEnv();
  const ids = ['g0123456789abcd.uy', 'g0123456789abce.ar'];
  const now = Math.floor(Date.now() / 1000);
  const file = (id: string) => createHash('sha1').update(id).digest('hex').slice(0, 16);
  const plot = 'Un detective retirado vuelve para un último caso en su ciudad natal.';
  await t.env.BUCKET.put(`ui/schedule/${file(ids[0])}.json`, JSON.stringify([[now - 1800, now + 3600, 'Peli', plot], [now + 7200, now + 12600, 'Peli', plot]]));
  const post = (body: unknown) => handle(new Request('https://w.test/api/ui/again', { method: 'POST', body: JSON.stringify(body) }), t.env, t.ctx, t.cache);
  const res = await post({ ids: [ids[1], ids[0], ids[0]] });
  assert.equal(res.status, 200);
  const data = await res.json() as { ids: string[]; r: unknown[] };
  assert.deepEqual(data.ids, ids);
  assert.deepEqual(data.r, [[0, now - 1800, [[0, now + 7200]]]]);
  await t.settle();
  t.env.BUCKET.data.clear();
  assert.deepEqual((await (await post({ ids })).json() as { r: unknown[] }).r, data.r, 'de la caché');
  assert.equal((await post({ ids: ['ESPN.us'] })).status, 400);
  assert.equal((await post({ ids: [] })).status, 400);
});
