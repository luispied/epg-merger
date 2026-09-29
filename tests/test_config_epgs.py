"""Guía de cada configuración de Grilla web (tools/config_epgs.py)."""
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import config_epgs  # noqa: E402

MERGED = b"""<?xml version="1.0" encoding="UTF-8" ?>
<tv generator-info-name="epg-merger">
  <channel id="Telefe.ar"><display-name>Telefe</display-name></channel>
  <channel id="ESPN.ar"><display-name>ESPN</display-name></channel>
  <channel id="TBS.us"><display-name>TBS</display-name></channel>
  <programme channel="ESPN.ar" start="20260929120000 +0000" stop="20260929130000 +0000"><title>SportsCenter</title></programme>
  <programme channel="TBS.us" start="20260929120000 +0000" stop="20260929130000 +0000"><title>Friends</title></programme>
  <programme channel="Telefe.ar" start="20260929120000 +0000" stop="20260929130000 +0000"><title>Noticiero</title></programme>
</tv>
"""


def test_una_guia_por_configuracion_con_sus_canales(tmp_path):
    merged = tmp_path / 'merged.xml.gz'
    merged.write_bytes(gzip.compress(MERGED))
    cfgs = tmp_path / 'cfg'
    cfgs.mkdir()
    (cfgs / 'aaaaaaaaaaaaaaaaaaaaaa.json').write_text(json.dumps({'channels': {
        'AR| Telefe': {'epg': 'Telefe.ar'}, 'ESPN': {'epg': 'ESPN.ar'}, 'Oculto': {'hidden': True},
        'Sin EPG': {'epg': None}, 'Colgado': {'epg': 'NoExiste.xx'}}}))
    (cfgs / 'bbbbbbbbbbbbbbbbbbbbbb.json').write_text(json.dumps({'channels': {}}))
    (cfgs / 'roto.json').write_text('{')

    stats = config_epgs.build(config_epgs.load_configs(str(cfgs)), str(merged), str(tmp_path / 'out'))
    assert stats == {'aaaaaaaaaaaaaaaaaaaaaa': 2, 'bbbbbbbbbbbbbbbbbbbbbb': 0}

    xml = gzip.decompress((tmp_path / 'out' / 'aaaaaaaaaaaaaaaaaaaaaa.xml.gz').read_bytes()).decode()
    assert 'id="Telefe.ar"' in xml and 'id="ESPN.ar"' in xml and 'TBS' not in xml
    assert 'Noticiero' in xml and 'SportsCenter' in xml and 'Friends' not in xml
    # Todos los <channel> antes que el primer <programme> (como pide XMLTV).
    assert xml.rindex('<channel') < xml.index('<programme')
    empty = gzip.decompress((tmp_path / 'out' / 'bbbbbbbbbbbbbbbbbbbbbb.xml.gz').read_bytes()).decode()
    assert '<channel' not in empty and '</tv>' in empty


def test_sin_configuraciones_no_hace_nada(tmp_path):
    assert config_epgs.build({}, 'no-existe.xml.gz', str(tmp_path / 'out')) == {}
    assert not (tmp_path / 'out').exists()
