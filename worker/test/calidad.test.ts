import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig, showQuality } from '../src/config.ts';
import { buildPlaylist } from '../src/playlist.ts';
import { nameWithQuality, qualityLabel, qualityMap } from '../src/quality.ts';

const ch = (name: string, id = name) => ({ name, category: 'Noticias', id, ext: 'ts', icon: '', epgId: null });
const CHANNELS = [ch('TNT HD', 'a'), ch('ESPN 4K', 'b'), ch('Canal 9 SD', 'c'), ch('Discovery', 'd')];
const names = (text: string) => [...text.matchAll(/tvg-name="([^"]*)"/g)].map((m) => m[1]);
const cfgWith = (extra: Record<string, unknown>) => parseConfig({ provider: { type: 'm3u' }, channels: {}, ...extra });
const Q = new Map([['a', 'FHD'], ['b', '4K'], ['c', 'SD']] as const);

test('calidad: las franjas de alto son las de Canales', () => {
  assert.equal(qualityLabel(480), 'SD');
  assert.equal(qualityLabel(720), 'HD');
  assert.equal(qualityLabel(1080), 'FHD');
  assert.equal(qualityLabel(2160), '4K');
  assert.equal(qualityMap({ x: { t: '', w: 1920, h: 1080 }, y: { t: '' } }).get('x'), 'FHD');
  assert.equal(qualityMap({ y: { t: '' } }).size, 0);
});

test('calidad: reemplaza el texto del proveedor por la medida en letras pequeñas', () => {
  assert.equal(nameWithQuality('TNT HD', 'FHD'), 'TNT ᶠᴴᴰ');
  assert.equal(nameWithQuality('ESPN 4K', '4K'), 'ESPN ⁴ᴷ');
  assert.equal(nameWithQuality('Canal 9 (SD)', 'SD'), 'Canal 9 ˢᴰ');
  assert.equal(nameWithQuality('TLC -EN ᵁᴴᴰ', 'HD'), 'TLC -EN ᴴᴰ');
  assert.equal(nameWithQuality('Discovery 1080p', 'HD'), 'Discovery ᴴᴰ');
  assert.equal(nameWithQuality('Discovery', 'HD'), 'Discovery ᴴᴰ');
});

test('calidad: no toca palabras que solo contienen las letras', () => {
  assert.equal(nameWithQuality('Shdow Channel', 'HD'), 'Shdow Channel ᴴᴰ');
  assert.equal(nameWithQuality('Canal HDMI Plus', 'SD'), 'Canal HDMI Plus ˢᴰ');
});

test('calidad: apagada por defecto; sin medida el nombre queda como viene', () => {
  const cfg = cfgWith({});
  assert.equal(showQuality(cfg), false);
  const text = buildPlaylist(CHANNELS, cfg, { epgUrl: '', streamUrl: (c) => `/s/${c.id}`, qualities: Q });
  assert.deepEqual(names(text), ['TNT HD', 'ESPN 4K', 'Canal 9 SD', 'Discovery']);
});

test('calidad: la cuenta la prende, el perfil la hereda o la pisa, y sin medida no cambia', () => {
  const cfg = cfgWith({
    qualityAccounts: [''],
    profiles: [
      { id: 'hereda', name: 'Tu perfil' },
      { id: 'apaga', name: 'Sin calidad', quality: false },
      { id: 'otra', name: 'Otra', account: 'Papá' },
    ],
  });
  assert.equal(showQuality(cfg, cfg.profiles!.find((p) => p.id === 'hereda')), true);
  assert.equal(showQuality(cfg, cfg.profiles!.find((p) => p.id === 'apaga')), false);
  assert.equal(showQuality(cfg, cfg.profiles!.find((p) => p.id === 'otra')), false);
  const on = buildPlaylist(CHANNELS, cfg, { epgUrl: '', streamUrl: (c) => `/s/${c.id}`, quality: true, qualities: Q });
  assert.deepEqual(names(on), ['TNT ᶠᴴᴰ', 'ESPN ⁴ᴷ', 'Canal 9 ˢᴰ', 'Discovery']);
});

test('calidad: la lista de cuentas se limpia y no repite', () => {
  const cfg = parseConfig({ provider: { type: 'm3u' }, channels: {}, qualityAccounts: ['Mamá', '  Mamá  ', 42], profiles: [] });
  assert.deepEqual(cfg.qualityAccounts, ['Mamá']);
});
