import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isApt, kidsReport, maskEntries, maskHour, parseKids } from '../src/kids.ts';

test('perfil infantil: Infantil y Educativo entran siempre, los opcionales solo si se piden, y Publicidad nunca', () => {
  const k = parseKids({ genres: ['Publicidad', 'Película', 'Cocina', 'Cocina', 'Deportes', 1] })!;
  assert.deepEqual(k.genres, ['Infantil', 'Educativo', 'Cocina', 'Deportes']);
  assert.deepEqual(parseKids({})!.genres, ['Infantil', 'Educativo']);
  assert.equal(parseKids(null), undefined);
  assert.equal(parseKids('si'), undefined);
  assert.equal(parseKids([]), undefined);
  assert.ok(isApt('Infantil', k) && isApt('Cocina', k));
  assert.ok(!isApt('Música', k) && !isApt('Película', k) && !isApt('Publicidad', k) && !isApt('', k) && !isApt(undefined, k));
  assert.ok(!isApt('Publicidad', { genres: ['Publicidad', 'Infantil'] })); // aunque venga a mano en la configuración
});

test('perfil infantil: lo que no es apto sale sin título, descripción ni género, y conserva su hora', () => {
  const k = parseKids({})!;
  assert.deepEqual(maskHour({ h: 5, t: ['A', 'B', 'C'], g: ['Infantil', 'Serie', ''], c: { x: [[0, 5, 0], [5, 9, 1], [9, 12, 2]] } }, k),
    { h: 5, t: ['A', '', ''], g: ['Infantil', '', ''], c: { x: [[0, 5, 0], [5, 9, 1], [9, 12, 2]] } });
  assert.deepEqual(maskHour({ h: 5, t: ['A'], c: {} }, k).t, ['']); // sin géneros todavía: nada se ve
  assert.deepEqual(maskEntries([[1, 2, 'A', 'desc', 'Educativo'], [2, 3, 'B', 'desc', 'Serie'], [3, 4, 'C', 'desc']], k),
    [[1, 2, 'A', 'desc', 'Educativo'], [2, 3, ''], [3, 4, '']]);
});

test('perfil infantil: el resumen de lo que se oculta cuenta títulos distintos, por género y sin clasificar', () => {
  const k = parseKids({})!;
  const idx = { h: 0, t: ['Dibu', 'Peli uno', 'Peli dos', 'Misterio', 'dibu'], g: ['Infantil', 'Película', 'Película', '', 'Infantil'],
    c: { x: [[0, 5, 0], [5, 9, 1], [9, 12, 2]], y: [[0, 5, 3], [5, 9, 4]], z: [[0, 5, 1]] } };
  const r = kidsReport([idx, null], new Set(['x', 'y']), k);
  assert.equal(r.hours, 2);
  assert.equal(r.shown, 1); // «Dibu» y «dibu» son el mismo
  assert.equal(r.hidden, 3);
  assert.deepEqual(r.by, [{ genre: 'Película', n: 2, sample: ['Peli uno', 'Peli dos'] }, { genre: '', n: 1, sample: ['Misterio'] }]);
});
