"""Guía compartida para Grilla web (shared_guide.py): el índice que usa @grilla/core."""
import datetime
import json
import os
import sys

from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shared_guide  # noqa: E402

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
    # Sin URLs de las fuentes: solo lo que usa el matcher.
    assert index['sources'] == {'openepg-ar': {'country': 'ar', 'priority': 3},
                                'acidjesuz-us': {'country': None, 'priority': 0}}
    # En el orden de la guía (el desempate del matcher depende de él) y sin los canales sin id.
    assert index['channels'] == [
        {'id': 'Telefe.ar', 'source': 'openepg-ar', 'names': ['Telefe'], 'icon': 'http://x/t.png'},
        {'id': 'TBS.us', 'source': 'acidjesuz-us', 'names': ['TBS', 'TBS HD'], 'icon': ''},
    ]

    path = shared_guide.write_index(index, str(tmp_path))
    with open(path, encoding='utf-8') as f:
        assert json.load(f) == index
