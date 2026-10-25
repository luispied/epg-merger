import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genreCategory, MIXED, SALES } from '../src/genre-views.ts';
import { parseConfig, parseViews, viewConfig, type Config } from '../src/config.ts';
import { parseFilter } from '../src/playlist.ts';

test('genreCategory: sin datos queda en la del proveedor, sin género claro va a mixtos', () => {
  assert.equal(genreCategory(undefined), null);
  assert.equal(genreCategory(['Deportes', 9, 19]), MIXED); // pocos programas
  assert.equal(genreCategory(['Deportes', 20, 60]), MIXED); // menos de la mitad
  assert.equal(genreCategory(['Deportes', 40, 60]), 'Deportes');
  assert.equal(genreCategory(['Reality', 30, 30]), 'Entretenimiento');
  assert.equal(genreCategory(['Publicidad', 30, 30]), SALES);
});

test('parseConfig guarda la vista activa y la otra, y descarta lo inválido', () => {
  const cfg = parseConfig({
    provider: { type: 'm3u' },
    view: 'genre',
    groups: { order: ['Deportes'], hidden: ['Televentas'] },
    views: {
      provider: { groups: { order: ['ESPN'], hidden: [] }, assign: { ESPN: 'Deportes AR', x: 5 } },
      genre: 'no es un objeto',
    },
  });
  assert.equal(cfg.view, 'genre');
  assert.deepEqual(cfg.groups?.hidden, ['Televentas']);
  assert.deepEqual(cfg.views?.provider?.assign, { ESPN: 'Deportes AR' });
  assert.deepEqual(cfg.views?.provider?.groups.order, ['ESPN']);
  assert.equal(cfg.views?.genre, undefined);
  assert.equal(parseConfig({ provider: { type: 'm3u' } }).view, undefined);
  assert.equal(parseViews('nada'), undefined);
});

test('viewConfig: la vista del perfil sale de la guardada aparte; la activa queda igual', () => {
  const cfg = parseConfig({
    provider: { type: 'm3u' },
    groups: { order: ['Deportes'], hidden: [] },
    channels: { ESPN: { group: 'Deportes' }, CNN: { group: 'Noticias' } },
    views: {
      provider: { groups: { order: ['Deportes', 'Noticias'], hidden: [] }, assign: { ESPN: 'Deportes', CNN: 'Noticias' } },
      genre: { groups: { order: ['Documental'], hidden: [] }, assign: { CNN: 'Documental' } },
    },
  }) as Config;
  assert.equal(viewConfig(cfg), cfg); // proveedor: la activa
  const genre = viewConfig(cfg, 'genre');
  assert.deepEqual(genre.groups.order, ['Documental']);
  assert.equal(genre.channels.CNN.group, 'Documental');
  assert.equal(genre.channels.ESPN.group, undefined); // sin género: vuelve a su categoría del proveedor
  assert.equal(cfg.channels.CNN.group, 'Noticias'); // la configuración no cambia
  assert.equal(viewConfig(parseConfig({ provider: { type: 'm3u' } }), 'genre').view, undefined); // sin vista guardada
});

test('parseFilter: la vista cuenta aunque no haya categorías ni canales ocultos', () => {
  assert.deepEqual(parseFilter({ groups: [], channels: [], view: 'genre' }), { groups: [], channels: [], view: 'genre' });
  assert.equal(parseFilter({ groups: [], channels: [], view: 'otra' }), undefined);
  assert.equal(parseFilter({ groups: [], channels: [] }), undefined);
});
