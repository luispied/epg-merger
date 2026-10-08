"""Guía compartida para Grilla web (shared_guide.py): el índice que usa @grilla/core."""
import datetime
import json
import os
import sys

from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shared_guide  # noqa: E402
from source_alias import logo_key, logo_path, source_alias  # noqa: E402


def test_alias_estable_y_opaco():
    assert source_alias('epgshare-us2') == 's4b1fdd7b'
    assert source_alias('epgshare-us2') != source_alias('epgshare-us1')
    assert source_alias(None) is None

GUIDE = b"""<tv>
  <channel id="Telefe.ar" source="openepg-ar"><display-name>Telefe</display-name><icon src="http://x/t.png"/></channel>
  <channel id="TBS.us" source="acidjesuz-us"><display-name>TBS</display-name><display-name>TBS HD</display-name></channel>
  <channel><display-name>Sin id</display-name></channel>
</tv>"""


def test_indice_con_canales_fuentes_y_reglas(tmp_path):
    sources = [{'id': 'openepg-ar', 'url': 'https://secreto/ar.xml', 'country': 'ar', 'priority': 3},
               {'id': 'acidjesuz-us', 'url': 'https://x/us.xml'}]
    now = datetime.datetime(2026, 9, 29, 12, 0, tzinfo=datetime.timezone.utc)
    index = shared_guide.build_index(etree.fromstring(GUIDE), sources, {'quality_tokens': ['hd']}, now)

    assert index['generated_at'] == '2026-09-29T12:00:00Z'
    assert index['matching_rules'] == {'quality_tokens': ['hd']}
    # Sin URLs de las fuentes y con su alias en vez del id: solo lo que usa el matcher.
    ar, us = source_alias('openepg-ar'), source_alias('acidjesuz-us')
    assert index['sources'] == {ar: {'country': 'ar', 'priority': 3}, us: {'country': None, 'priority': 0}}
    assert 'openepg' not in json.dumps(index) and 'acidjesuz' not in json.dumps(index)
    # En el orden de la guía (el desempate del matcher depende de él) y sin los canales sin id.
    assert index['channels'] == [
        {'id': 'Telefe.ar', 'source': ar, 'names': ['Telefe'], 'icon': logo_path('http://x/t.png')},
        {'id': 'TBS.us', 'source': us, 'names': ['TBS', 'TBS HD'], 'icon': ''},
    ]

    assert 'x/t.png' not in json.dumps(index)

    path = shared_guide.write_index(index, str(tmp_path))
    with open(path, encoding='utf-8') as f:
        assert json.load(f) == index


def test_logos_por_el_worker(tmp_path):
    # Misma clave que logoKey en worker/src/logos.ts.
    assert logo_key('http://x/t.png') == 'b4009f79b7b3189c'
    assert logo_path('http://x/t.png') == '/logo/b4009f79b7b3189c'
    assert logo_path('') == ''
    logos = shared_guide.logo_map(etree.fromstring(GUIDE))
    assert logos == {'b4009f79b7b3189c': 'http://x/t.png'}
    path = shared_guide.write_logo_map(logos, str(tmp_path))
    assert path.endswith(os.path.join('logo', 'map.json'))
    with open(path, encoding='utf-8') as f:
        assert json.load(f) == logos
