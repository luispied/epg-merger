// Tests de @grilla/core (los mismos casos que tests/test_matching.py, más el matching de un
// canal). La paridad completa con Python está en parity.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ChannelDb, EpgIndex, MatchingRules, MIN_SCORE, calibratedScore, flagToCountryCode, matchStream,
  parseChannelName, pickDisplayName, stripDisplayPrefix, tvgIdCountry, type GuideChannel, type SourceInfo,
} from '../src/index.ts';

const rules = new MatchingRules(JSON.parse(readFileSync(new URL('../../matching_rules.json', import.meta.url), 'utf-8')));
const parse = (name: string) => parseChannelName(name, rules);
const index = (channels: [string, string[], string?][], sources: Record<string, SourceInfo> = {}) =>
  new EpgIndex(channels.map(([id, names, source]): GuideChannel => ({ id, names, source })), rules, sources);
const best = (idx: EpgIndex, name: string, prefer: string[] = [], country: string | null = null) =>
  idx.rank(parse(name), prefer, country)[0]?.channelId ?? null;

test('parseo: idioma, país, calidad y región son señales aparte', () => {
  assert.deepEqual([parse('TBS -EN').core, parse('TBS -EN').language], [['tbs'], 'en']);
  assert.deepEqual([parse('Warner TV Costa Rica').core, parse('Warner TV Costa Rica').country], [['warner', 'tv'], 'cr']);
  assert.deepEqual([parse('PE | Latina').core, parse('PE | Latina').country], [['latina'], 'pe']);
  assert.deepEqual(parse('E! Entertainment Television').core, ['e', 'entertainment', 'television']);
  const p = parse('TBS East HD');
  assert.deepEqual([p.core, p.region, p.quality], [['tbs'], 'east', ['hd']]);
  assert.deepEqual(parse('DAZN 01').core, ['dazn', '1']);
  assert.deepEqual(parse('Dazn F 1').core, ['dazn', 'f1']);
  assert.deepEqual(parse('DSports+').core, ['dsports', 'plus']);
  assert.deepEqual(parse('Clan (1080p) [Geo-blocked]').core, ['clan']);
});

test('prefijo visible del proveedor', () => {
  for (const [raw, clean, country] of [
    ['UY| Canal 10', 'Canal 10', 'uy'], ['ES: La 1', 'La 1', 'es'], ['USA| CBS', 'CBS', 'us'],
    ['E| Entertainment', 'Entertainment', null], ['EVENTS 12:UFC 300', 'UFC 300', null], ['24H Cinema', 'Cinema', null],
    ['ESPN', 'ESPN', null], ['USA Network', 'USA Network', null],
  ] as const) assert.deepEqual(stripDisplayPrefix(raw, rules), [clean, country]);
});

test('bandera, id de EPG y display-name', () => {
  assert.equal(flagToCountryCode('🇦🇷 DEPORTES', rules), 'ar');
  assert.equal(flagToCountryCode('🇬🇧 UK', rules), 'uk');
  assert.equal(flagToCountryCode('ESPN', rules), null);
  assert.equal(tvgIdCountry('Clan.es@SD', rules), 'es');
  assert.equal(tvgIdCountry('Telefe.ar', rules), 'ar');
  assert.equal(tvgIdCountry('sin-pais', rules), null);
  assert.equal(pickDisplayName(['Laff', '247 Laff', '247']), 'Laff');
});

test('puntaje: nombre exacto, país, idioma, fuente preferida y región', () => {
  const laff = index([['LaffLocal.us', ['Laff (WUOA) Birmingham, AL']], ['Laff.us', ['Laff']]]);
  assert.deepEqual(laff.rank(parse('Laff')).map((c) => c.channelId), ['Laff.us', 'LaffLocal.us']);
  assert.equal(best(index([['ESPN.ar', ['ESPN']], ['Otro.ar', ['TyC Sports']]]), 'ESPN 1 ARG'), 'ESPN.ar');
  assert.equal(best(index([['Canal26.cl', ['Canal 26']], ['Canal26.ar', ['Canal 26']]]), 'Canal 26', [], 'ar'), 'Canal26.ar');
  assert.ok(index([['Canal26.cl', ['Canal 26']]]).rank(parse('Canal 26'), [], 'ar')[0].score < MIN_SCORE);
  const tbs = index([['TBS.mx', ['TBS'], 'mx1'], ['TBS.us', ['TBS'], 'us1']], { mx1: { country: 'mx' }, us1: { country: 'us' } });
  assert.equal(best(tbs, 'TBS -EN'), 'TBS.us');
  assert.equal(best(index([['TBS.a', ['TBS'], 'a'], ['TBS.b', ['TBS'], 'b']]), 'TBS', ['b']), 'TBS.b');
  assert.equal(best(index([['TBSP.us', ['TBS Pacific']], ['TBSE.us', ['TBS East']]]), 'TBS East'), 'TBSE.us');
  assert.equal(best(index([['TBSP.us', ['TBS (Pacific)']], ['TBSE.us', ['TBS HD']]]), 'TBS'), 'TBSE.us');
});

test('nombre a medias no llega a "Bien"', () => {
  assert.equal(calibratedScore({ channelId: 'x', score: 0.95, nameScore: 0.6, reason: 'country' }), 0.69);
  assert.equal(calibratedScore({ channelId: 'x', score: 0.95, nameScore: 0.8, reason: 'country' }), 0.95);
});

test('matchStream: override, umbral, palabras pegadas e id de la lista', () => {
  const idx = index([['RTLZwei.de', ['RTLZWEI']], ['Clan.es', ['Clan']], ['Canal13.ar', ['El Trece']], ['Otro.es', ['Otra Cosa']]]);
  assert.deepEqual(
    [matchStream('AR| Tele', null, idx, { 'AR| Tele': null }, {}, null)].map((r) => [r.name, r.channelId, r.reason]),
    [['Tele', null, 'override']]);
  const joined = matchStream('RTL Zwei', null, idx, {}, {}, null);
  assert.equal(joined.channelId, 'RTLZwei.de');
  // El id de la lista (M3U) gana si el nombre tiene algo que ver; en Xtream solo si no hubo match.
  const byId = matchStream('Clan TV', 'Clan.es@SD', idx, {}, {}, null);
  assert.deepEqual([byId.channelId, byId.reason], ['Clan.es', 'xtream_epg_id']);
  assert.equal(matchStream('Nada que ver', 'Clan.es@SD', idx, {}, {}, null).channelId, null);
  // Diccionario de iptv-org: "13" no encuentra nada, su otro nombre sí (país confirmado).
  const db = new ChannelDb([{ id: 'ElTrece.ar', name: 'Canal 13', alt_names: ['El Trece'], country: 'AR' }], rules);
  assert.equal(matchStream('Canal 13', null, idx, {}, {}, 'ar').channelId, null);
  const alias = matchStream('Canal 13', null, idx, {}, {}, 'ar', { channelDb: db });
  assert.deepEqual([alias.channelId, alias.reason], ['Canal13.ar', 'alias']);
});
