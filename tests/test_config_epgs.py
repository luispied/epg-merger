"""Guía de cada configuración de Grilla web (tools/config_epgs.py)."""
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import config_epgs  # noqa: E402
import source_alias  # noqa: E402
from source_alias import channel_alias  # noqa: E402

MERGED = b"""<?xml version="1.0" encoding="UTF-8" ?>
<tv generator-info-name="epg-merger">
  <channel id="Telefe.ar" source="openepg-argentina"><display-name>Telefe</display-name><icon src="http://x/t.png"/><url>https://www.ejemplo-fuente.test</url></channel>
  <channel id="ESPN.ar"><display-name>ESPN</display-name></channel>
  <channel id="TBS.us"><display-name>TBS</display-name></channel>
  <programme channel="ESPN.ar" start="20260929120000 +0000" stop="20260929130000 +0000"><title>SportsCenter</title></programme>
  <programme channel="TBS.us" start="20260929120000 +0000" stop="20260929130000 +0000"><title>Friends</title></programme>
  <programme channel="Telefe.ar" start="20260929120000 +0000" stop="20260929130000 +0000"><title>Noticiero</title><desc>Info https://ejemplo-fuente.test/help</desc><icon src="http://y/p.jpg"/></programme>
</tv>
"""


def test_una_guia_por_configuracion_con_sus_canales(tmp_path, monkeypatch):
    # Los sitios de las fuentes salen de epg_urls.json (que ya no está en el repo): acá se fijan a mano.
    monkeypatch.setattr(source_alias, 'source_sites', lambda: frozenset({'ejemplo-fuente.test'}))
    merged = tmp_path / 'merged.xml.gz'
    merged.write_bytes(gzip.compress(MERGED))
    cfgs = tmp_path / 'cfg'
    cfgs.mkdir()
    (cfgs / 'aaaaaaaaaaaaaaaaaaaaaa.json').write_text(json.dumps({'channels': {
        # Una con el alias (la web nueva) y otra con el id real (guardada antes): las dos sirven.
        'AR| Telefe': {'epg': channel_alias('Telefe.ar')}, 'ESPN': {'epg': 'ESPN.ar'}, 'Oculto': {'hidden': True},
        'Sin EPG': {'epg': None}, 'Colgado': {'epg': 'NoExiste.xx'}}}))
    (cfgs / 'bbbbbbbbbbbbbbbbbbbbbb.json').write_text(json.dumps({'channels': {}}))
    (cfgs / 'roto.json').write_text('{')

    stats = config_epgs.build(config_epgs.load_configs(str(cfgs)), str(merged), str(tmp_path / 'out'))
    # Cada guía trae todos los canales de la fusionada, no solo los elegidos.
    assert stats == {'aaaaaaaaaaaaaaaaaaaaaa': 3, 'bbbbbbbbbbbbbbbbbbbbbb': 3}

    xml = gzip.decompress((tmp_path / 'out' / 'aaaaaaaaaaaaaaaaaaaaaa.xml.gz').read_bytes()).decode()
    # Cada canal sale con el id que guardó la configuración (el tvg-id de su playlist): el alias, también
    # en sus programas; el id real de una configuración que todavía no pasó por la web enmascarada.
    tel = channel_alias('Telefe.ar')
    assert f'id="{tel}"' in xml and f'channel="{tel}"' in xml and 'Telefe.ar' not in xml
    assert 'id="ESPN.ar"' in xml and 'channel="ESPN.ar"' in xml
    # Un canal que la configuración no eligió también sale, con su alias: así cambiarle la guía no necesita corrida.
    tbs = channel_alias('TBS.us')
    assert f'id="{tbs}"' in xml and f'channel="{tbs}"' in xml and 'TBS.us' not in xml
    assert 'Noticiero' in xml and 'SportsCenter' in xml and 'Friends' in xml
    # La fuente sale enmascarada.
    assert 'openepg' not in xml and 'source="s' in xml
    # Y el logo sale por el Worker.
    assert 'x/t.png' not in xml and 'src="https://grilla.grilla.workers.dev/logo/b4009f79b7b3189c"' in xml
    # Y nada más que delate la fuente: imágenes de programa por el Worker, sin <url> ni links de la fuente.
    assert 'y/p.jpg' not in xml and 'grilla.workers.dev/img/' in xml
    assert '<url>' not in xml and 'ejemplo-fuente.test' not in xml and '<desc>Info</desc>' in xml
    # Todos los <channel> antes que el primer <programme> (como pide XMLTV).
    assert xml.rindex('<channel') < xml.index('<programme')
    empty = gzip.decompress((tmp_path / 'out' / 'bbbbbbbbbbbbbbbbbbbbbb.xml.gz').read_bytes()).decode()
    assert f'id="{tel}"' in empty and '</tv>' in empty


def test_sin_configuraciones_no_hace_nada(tmp_path):
    assert config_epgs.build({}, 'no-existe.xml.gz', str(tmp_path / 'out')) == {}
    assert not (tmp_path / 'out').exists()
