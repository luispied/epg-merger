"""tools/learn_preferences.py: preferencias de fuente por categoría aprendidas de los overrides."""
import json
import os
import sys

from lxml import etree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import generate_playlist as gp  # noqa: E402
import learn_preferences as lp  # noqa: E402
from epg_index import EpgIndex  # noqa: E402
from match_benchmark import Judge  # noqa: E402


def _index():
    # Mismo nombre en dos fuentes de distinto país: para el comparador son canales distintos.
    chans = [('DAZN1.uk', 'DAZN 1', 'src-a'), ('DAZN2.uk', 'DAZN 2', 'src-a'),
             ('DAZN1.es', 'DAZN 1', 'src-b'), ('DAZN2.es', 'DAZN 2', 'src-b'), ('DAZN3.es', 'DAZN 3', 'src-b')]
    xml = '<tv>' + ''.join(f'<channel id="{c}" source="{s}"><display-name>{n}</display-name></channel>'
                           for c, n, s in chans) + '</tv>'
    return EpgIndex(etree.fromstring(xml), sources={'src-a': {'priority': 0}, 'src-b': {'priority': 1}})


def _report(*names):
    return [{'xtream_name': n, 'category': 'PPV DAZN', 'provider_epg_id': None} for n in names]


def test_aprende_la_fuente_de_los_overrides():
    idx = _index()
    report = _report('Dazn 1', 'Dazn 2', 'Dazn 3')
    channel_map = {'overrides': {'Dazn 1': 'DAZN1.es', 'Dazn 2': 'DAZN2.es'}}
    sections = ([], [], {}, {})
    sug = lp.learn(report, channel_map, idx, sections, Judge(idx))
    best = sug[0]
    assert (best['category'], best['source']) == ('PPV DAZN', 'src-b')
    assert sorted(best['gains']) == ['Dazn 1', 'Dazn 2']
    assert best['losses'] == [] and best['safe'], "'Dazn 3' solo existe en src-b: no cambia"


def test_aplicar_toca_solo_category_epg(tmp_path):
    path = tmp_path / 'playlist_sections.json'
    original = '{\n  "_comment": "x",\n  "order": { "A": 10 },\n  "rules": [\n    { "section": "A", "equals": ["a"] }\n  ]\n}\n'
    path.write_text(original, encoding='utf-8')
    done = lp.apply([{'category': 'PPV DAZN', 'source': 'src-b', 'safe': True},
                     {'category': 'Otra', 'source': 'x', 'safe': False}], str(path))
    assert done == ['PPV DAZN']
    text = path.read_text(encoding='utf-8')
    assert json.loads(text)['category_epg'] == {'PPV DAZN': {'prefer_sources': ['src-b']}}
    assert '    { "section": "A", "equals": ["a"] }' in text, "el resto del archivo queda como estaba"
    cfg = gp.epg_config_for('A', 'PPV DAZN', gp.load_sections_config(str(path))[2])
    assert cfg['prefer_sources'] == ['src-b']
