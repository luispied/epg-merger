import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendPoint, CONN_EVERY_MS, CONN_KEEP, type ConnPoint } from '../src/connlog.ts';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 29, 12, 0, 0) + ms);
const pt = (ms: number): ConnPoint => ({ t: at(ms).toISOString(), n: 1 });

test('una muestra nueva se agrega si la última tiene más de 10 minutos', () => {
  const next = appendPoint([pt(0)], { t: at(CONN_EVERY_MS).toISOString(), n: 2 }, at(CONN_EVERY_MS));
  assert.equal(next?.length, 2);
});

test('dentro de 10 minutos no se escribe otra muestra', () => {
  assert.equal(appendPoint([pt(0)], { t: at(1000).toISOString(), n: 2 }, at(1000)), null);
});

test('la serie se queda con las últimas 24 h', () => {
  const points = Array.from({ length: CONN_KEEP }, (_, i) => pt(i * CONN_EVERY_MS));
  const now = at(CONN_KEEP * CONN_EVERY_MS);
  const next = appendPoint(points, { t: now.toISOString(), n: 3 }, now);
  assert.equal(next?.length, CONN_KEEP);
  assert.equal(next?.at(-1)?.n, 3);
  assert.equal(next?.[0].t, pt(CONN_EVERY_MS).t);
});
