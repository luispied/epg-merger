// Paridad con el matcher de Python: corre matchStream sobre los casos que exportó
// tools/core_parity.py y compara canal, motivo y puntaje con lo que eligió Python.
// Uso: node core/test/parity.ts [casos.json] [--min 0.99] [--show 20]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ChannelDb, EpgIndex, flagToCountryCode, MatchingRules, matchStream } from '../src/index.ts';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const minRate = Number(opt('--min', '0.99'));
const show = Number(opt('--show', '20'));
const path = args[0] ?? new URL('./fixtures/parity.json.gz', import.meta.url).pathname;
const raw = readFileSync(path);
const data = JSON.parse((path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf-8'));

const rules = new MatchingRules(data.matching_rules);
const index = new EpgIndex(data.channels, rules, data.sources);
const db = data.channel_db ? new ChannelDb(data.channel_db, rules) : null;

let total = 0;
let same = 0;
let ok = true;
for (const suite of data.suites) {
  index.preferredFeed = suite.preferred_feed;
  let suiteSame = 0;
  const diffs: string[] = [];
  for (const c of suite.cases) {
    if (c.category_country && flagToCountryCode(c.category, rules) !== c.category_country) {
      diffs.push(`bandera ${c.category}: ${flagToCountryCode(c.category, rules)} ≠ ${c.category_country}`);
    }
    const got = matchStream(c.name, c.tvg_id, index, {}, c.epg_config, c.category_country, {
      trustListIds: suite.trust_list_ids, minAssignScore: suite.min_assign_score, channelDb: db,
    });
    const exp = c.expected;
    if (got.channelId === exp.channel_id && got.reason === exp.reason && Math.abs(got.score - exp.score) < 1e-9) {
      suiteSame++;
    } else {
      diffs.push(`${c.name}: ${got.channelId} (${got.reason}, ${got.score.toFixed(4)}) ≠ ` +
        `${exp.channel_id} (${exp.reason}, ${Number(exp.score).toFixed(4)})`);
    }
  }
  const n = suite.cases.length;
  total += n;
  same += suiteSame;
  console.log(`${suite.name}: ${suiteSame}/${n} iguales (${((100 * suiteSame) / n).toFixed(2)} %)`);
  for (const d of diffs.slice(0, show)) console.log('   ' + d);
  if (suiteSame / n < minRate) ok = false;
}
console.log(`Total: ${same}/${total} (${((100 * same) / total).toFixed(2)} %), mínimo ${minRate * 100} % por grupo`);
process.exit(ok ? 0 : 1);
