"""Guía compartida para Grilla web (shared_guide.py): el índice que usa @grilla/core."""
import datetime
import json
import os
import sys

from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shared_guide  # noqa: E402
from source_alias import logo_key, logo_path, scrub_element, scrub_text, source_alias  # noqa: E402


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


def test_imagenes_por_el_worker(tmp_path):
    # Misma clave que mediaKey en worker/src/logos.ts.
    assert logo_key('http://x/t.png') == 'b4009f79b7b3189c'
    assert logo_path('http://x/t.png') == '/logo/b4009f79b7b3189c'
    assert logo_path('http://x/t.png', 'img') == '/img/b4009f79b7b3189c'
    assert logo_path('') == ''
    progs = etree.fromstring(b"""<tv><programme channel="Telefe.ar"><title>A</title><icon src="http://y/p.jpg"/></programme>
      <programme channel="TBS.us"><title>B</title></programme></tv>""").findall('programme')
    maps = shared_guide.media_maps(etree.fromstring(GUIDE), progs)
    pk = logo_key('http://y/p.jpg')
    assert maps == {'logo': {'b4009f79b7b3189c': 'http://x/t.png'}, 'img': {pk: 'http://y/p.jpg'}}
    shared_guide.write_media_maps(maps, str(tmp_path))
    # Un archivo por prefijo: 1 caracter para logos, 2 para imágenes de programa.
    with open(tmp_path / 'logo' / 'map' / 'b.json', encoding='utf-8') as f:
        assert json.load(f) == maps['logo']
    with open(tmp_path / 'img' / 'map' / f'{pk[:2]}.json', encoding='utf-8') as f:
        assert json.load(f) == maps['img']


def test_sin_rastros_de_la_fuente():
    sites = frozenset({'fuente.org'})
    assert scrub_text('Ver https://fuente.org/help y https://canal.com', sites) == 'Ver y https://canal.com'
    assert scrub_text('https://img.fuente.org/x', sites) == ''
    assert scrub_text('Sin links', sites) == 'Sin links'
    prog = etree.fromstring(b"""<programme channel="X"><title>Noticias</title><desc>https://fuente.org/help</desc>
      <icon src="http://y/p.jpg"/><url>https://fuente.org</url></programme>""")
    scrub_element(prog, 'img', sites)
    xml = etree.tostring(prog).decode()
    assert 'fuente.org' not in xml and '<desc' not in xml and '<url' not in xml and 'y/p.jpg' not in xml
    assert f'src="https://grilla.grilla.workers.dev/img/{logo_key("http://y/p.jpg")}"' in xml
    # Dos veces da lo mismo (un programa va a varias guías).
    assert etree.tostring(scrub_element(prog, 'img', sites)).decode() == xml
