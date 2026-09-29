# @grilla/core

El matcher de EPG de Grilla en TypeScript, para correrlo en el navegador (Etapa 1: la web sin
GitHub, ver `planes/etapa-1-web-sin-github.md`). Es un port línea por línea de:

| TypeScript | Python |
|---|---|
| `src/names.ts` | `channel_names.py` |
| `src/epgIndex.ts` | `epg_index.py` |
| `src/channelDb.ts` | `channel_db.py` |
| `src/match.ts` | `match_channel`, `calibrated_score`, `tvg_id_country`, `match_stream` de `generate_playlist.py` |

Sin dependencias. Node 22 corre los `.ts` directo (solo sintaxis de tipos que se puede borrar),
`tsc` chequea tipos y compila a `dist/` para el navegador.

```ts
import { EpgIndex, MatchingRules, matchStream } from '@grilla/core';
const rules = new MatchingRules(matchingRulesJson);
const index = new EpgIndex(guideChannels, rules, sources); // [{id, source, names, icon}]
const m = matchStream('AR| Telefe HD', null, index, overrides, epgConfig, 'ar', { trustListIds: false, minAssignScore: 0.45 });
// m.channelId, m.reason, m.score, m.ranked (alternativas)
```

## Paridad con Python

Los dos matchers tienen que dar **exactamente** lo mismo (canal, motivo y puntaje).

- `tools/core_parity.py` exporta la guía, las reglas y los casos con lo que elige Python.
- `node core/test/parity.ts [casos.json]` corre TypeScript sobre lo mismo y compara.
- `core/test/fixtures/parity.json.gz` es un fixture chico (bancos de prueba públicos, guía
  recortada a 3.000 canales) que el CI prueba en cada PR (`check-core.yml`), y
  `tests/test_core_parity.py` lo verifica del lado de Python.
- La corrida diaria (`merge-epgs.yml`) compara además con la guía y la lista reales.

**Si se cambia el matcher de Python** (o `matching_rules.json`), hacer el mismo cambio acá y
regenerar el fixture:

```sh
python tools/core_parity.py --merged merged.xml.gz --sample 3000 --out /tmp/parity.json
gzip -9 -c /tmp/parity.json > core/test/fixtures/parity.json.gz
node core/test/parity.ts && python -m pytest tests/test_core_parity.py
```

Medido el 29/09/2026 con la guía real (16.633 canales): 6.173 de 6.173 iguales (bancos de
prueba con y sin `tvg-id`, y la lista de Luis). Velocidad: ~0,8 ms por canal en Node.
