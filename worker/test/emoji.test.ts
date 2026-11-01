import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig, showEmoji } from '../src/config.ts';
import { buildPlaylist } from '../src/playlist.ts';

const ch = (name: string, category: string) => ({ name, category, id: name, ext: 'ts', icon: '', epgId: null });
const CHANNELS = [ch('A', '🇦🇷 Argentina'), ch('B', '⚽️ ESPN'), ch('C', 'Noticias')];
const titles = (text: string) => [...text.matchAll(/group-title="([^"]*)"/g)].map((m) => m[1]);
const cfgWith = (extra: Record<string, unknown>) => parseConfig({ provider: { type: 'm3u' }, channels: {}, ...extra });

test('emoji: apagado por defecto, la playlist lo saca', () => {
  const cfg = cfgWith({});
  assert.equal(showEmoji(cfg), false);
  const text = buildPlaylist(CHANNELS, cfg, { epgUrl: '', streamUrl: (c) => `/s/${c.id}` });
  assert.deepEqual(titles(text), ['Argentina', 'ESPN', 'Noticias']);
});

test('emoji: la cuenta lo prende y el perfil lo hereda; el perfil lo pisa en los dos sentidos', () => {
  const cfg = cfgWith({
    emojiAccounts: ['', 'Mamá'],
    profiles: [
      { id: 'hereda', name: 'Tu perfil' },
      { id: 'apaga', name: 'Sin emoji', emoji: false },
      { id: 'mama', name: 'Mamá', account: 'Mamá' },
      { id: 'otra', name: 'Otra', account: 'Papá' },
      { id: 'prende', name: 'Con emoji', account: 'Papá', emoji: true },
    ],
  });
  const p = (id: string) => cfg.profiles!.find((x) => x.id === id);
  assert.equal(showEmoji(cfg, p('hereda')), true);
  assert.equal(showEmoji(cfg, p('apaga')), false);
  assert.equal(showEmoji(cfg, p('mama')), true);
  assert.equal(showEmoji(cfg, p('otra')), false);
  assert.equal(showEmoji(cfg, p('prende')), true);
  const text = buildPlaylist(CHANNELS, cfg, { epgUrl: '', streamUrl: (c) => `/s/${c.id}`, emoji: true });
  assert.deepEqual(titles(text), ['🇦🇷 Argentina', '⚽️ ESPN', 'Noticias']);
});

test('emoji: la lista de cuentas se limpia y no repite', () => {
  const cfg = parseConfig({ provider: { type: 'm3u' }, channels: {}, emojiAccounts: ['Mamá', '  Mamá  ', 42], profiles: [] });
  assert.deepEqual(cfg.emojiAccounts, ['Mamá']);
});
