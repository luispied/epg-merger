import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connHistory, PROBABLE_AFTER_MS, probableLink } from '../src/connhist.ts';

const HOUR = 3600 * 1000;
const now = Date.UTC(2026, 9, 29, 12, 30); // 12:30 UTC: la hora actual empieza a las 12:00
const at = (ms: number) => new Date(ms).toISOString();

test('las 24 horas: la última es la hora actual, con el máximo de cada hora', () => {
  const h = connHistory([
    { t: at(now - 10 * 60e3), n: 2 },
    { t: at(now - 20 * 60e3), n: 3 },
    { t: at(now - 5 * HOUR), n: 1 },
  ], now);
  assert.equal(h.hours.length, 24);
  assert.equal(h.hours[23], 3);
  assert.equal(h.hours[18], 1);
  assert.equal(h.hours[0], null);
});

test('una muestra más vieja de 24 horas no entra en la barra', () => {
  const h = connHistory([{ t: at(now - 25 * HOUR), n: 4 }], now);
  assert.ok(h.hours.every((n) => n === null));
});

test('una subida se anota en rises; una bajada no', () => {
  const h = connHistory([
    { t: at(now - 30 * 60e3), n: 1 },
    { t: at(now - 20 * 60e3), n: 2 },
    { t: at(now - 10 * 60e3), n: 1 },
  ], now);
  assert.deepEqual(h.rises, [now - 20 * 60e3]);
});

test('probable: la subida cae dentro de 15 minutos después de abrir el canal', () => {
  const rise = now - 20 * 60e3;
  assert.equal(probableLink([rise], at(rise - 2 * 60e3)), true);
  assert.equal(probableLink([rise], at(rise - PROBABLE_AFTER_MS - 60e3)), false);
  assert.equal(probableLink([], at(rise)), false);
});
