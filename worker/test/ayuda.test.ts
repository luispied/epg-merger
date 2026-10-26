// La ayuda es una sola página (ui/ayuda.html) con una sección por pantalla y modo. Si una pantalla nueva no tiene su
// sección, o una sección no dice de qué modo es, este test falla.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../web/ui/ayuda.html', import.meta.url), 'utf-8');
const secciones = [...html.matchAll(/<section data-modo="(\w+)" data-pantalla="(\w+)">/g)].map((m) => `${m[1]}:${m[2]}`);

test('ayuda: cada sección dice su modo y su pantalla, y no quedan (?) en el texto', () => {
  assert.equal(html.match(/<section\b/g)?.length, secciones.length);
  assert.equal(html.match(/<\/section>/g)?.length, secciones.length);
  assert.doesNotMatch(html, /circle-help|help-btn|data-topic/);
});

test('ayuda: el editor tiene una sección por cada pantalla con (?) hasta ahora', () => {
  for (const pantalla of ['general', 'canales', 'guia', 'configuracion', 'categorias', 'perfil']) {
    assert.ok(secciones.includes(`editor:${pantalla}`), `falta la sección de ${pantalla} en el editor`);
  }
});

test('ayuda: el modo ver tiene su sección de Canales, Guía y Configuración', () => {
  for (const pantalla of ['general', 'canales', 'guia', 'configuracion']) {
    assert.ok(secciones.includes(`ver:${pantalla}`), `falta la sección de ${pantalla} en el modo ver`);
  }
});
