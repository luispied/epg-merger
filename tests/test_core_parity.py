"""El fixture de paridad de @grilla/core (core/test/fixtures/parity.json.gz) sigue dando lo
mismo con el matcher de Python. Si este test falla, se cambió el matcher de Python: hay que
hacer el mismo cambio en core/src/ y regenerar el fixture con tools/core_parity.py (ver
core/README.md), así los dos siguen dando exactamente lo mismo."""
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import generate_playlist as gp  # noqa: E402
from channel_db import ChannelDb  # noqa: E402
from channel_names import RULES_PATH  # noqa: E402
from core_parity import guide_root  # noqa: E402
from epg_index import EpgIndex  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'core', 'test', 'fixtures', 'parity.json.gz')


def test_fixture_de_paridad_sigue_igual_en_python():
    with gzip.open(FIXTURE, 'rt', encoding='utf-8') as f:
        data = json.load(f)
    with open(RULES_PATH, encoding='utf-8') as f:
        assert data['matching_rules'] == json.load(f), 'cambió matching_rules.json: regenerar el fixture'
    index = EpgIndex(guide_root(data['channels']), sources=data['sources'])
    db = ChannelDb(data['channel_db'], index.rules) if data.get('channel_db') is not None else None
    gp.set_channel_db(db)
    diffs = []
    try:
        for suite in data['suites']:
            gp.set_provider_rules({**gp.DEFAULT_PROVIDER_RULES, 'min_assign_score': suite['min_assign_score'],
                                   'preferred_feed': suite['preferred_feed']})
            index.preferred_feed = gp._rules.preferred_feed
            for case in suite['cases']:
                _, cid, reason, score, _ = gp.match_stream(
                    case['name'], case['tvg_id'], index, {}, case['epg_config'], case['category_country'],
                    trust_list_ids=suite['trust_list_ids'])
                exp = case['expected']
                if (cid, reason) != (exp['channel_id'], exp['reason']) or abs(score - exp['score']) > 1e-9:
                    diffs.append(f"{case['name']}: {cid} ({reason}) != {exp['channel_id']} ({exp['reason']})")
    finally:
        gp.set_channel_db(None)
        gp.set_provider_rules(gp.load_provider_rules(os.path.join(os.path.dirname(FIXTURE), 'no-existe.json')))
    assert not diffs, f"{len(diffs)} casos cambiaron, por ejemplo: {diffs[:5]}"
