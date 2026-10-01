"""tools/compare_web.py: comparar la playlist de Grilla web con la de GitHub."""
import json
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import compare_web as cw  # noqa: E402

GITHUB = '''#EXTM3U
#EXTINF:-1 tvg-id="Telefe.ar" tvg-name="Telefe" tvg-logo="" group-title="Argentina",Telefe
http://srv:8080/live/usuario/clave/101.ts
#EXTINF:-1 tvg-id="ESPN.ar" tvg-name="ESPN" tvg-logo="" group-title="Deportes",ESPN
http://srv:8080/live/usuario/clave/102.ts
#EXTINF:-1 tvg-id="Evento" tvg-name="Evento" tvg-logo="" group-title="PPV",Evento
http://srv:8080/live/usuario/clave/103.ts
'''


def test_parsea_sin_urls_y_empareja_por_id():
    e = cw.parse_playlist(GITHUB)
    assert [x['id'] for x in e] == ['101', '102', '103']
    assert e[0] == {'id': '101', 'tvg_id': 'Telefe.ar', 'name': 'Telefe', 'group': 'Argentina'}
    assert 'clave' not in json.dumps(e)


def test_compara_epg_nombre_categoria_y_orden():
    web = cw.parse_playlist('''#EXTM3U url-tvg=""
#EXTINF:-1 tvg-id="ESPN2.ar" tvg-name="ESPN" tvg-logo="" group-title="Deportes",ESPN
/s/102.ts
#EXTINF:-1 tvg-id="Telefe.ar" tvg-name="Telefe HD" tvg-logo="" group-title="Argentina",Telefe HD
/s/101.m3u8
#EXTINF:-1 tvg-id="Nuevo" tvg-name="Nuevo" tvg-logo="" group-title="PPV",Nuevo
/s/104.ts
''')
    r = cw.compare(cw.parse_playlist(GITHUB), web)
    assert r['both'] == 2 and r['only_github'] == ['Evento'] and r['only_web'] == ['Nuevo']
    assert r['epg'] == [('ESPN', 'ESPN.ar', 'ESPN2.ar')]
    assert r['name'] == [('Telefe', 'Telefe', 'Telefe HD')]
    assert r['order_first_diff'] == (0, 'Argentina', 'Deportes')
    texto = cw.report('luis', 'abcdef123456', r, set())
    assert 'Hay diferencias' in texto and 'ESPN2.ar' in texto


def test_dos_sin_epg_son_iguales_aunque_el_tvg_id_difiera():
    """Sin EPG, GitHub pone de tvg-id el nombre crudo y la web el visible: no es diferencia."""
    gh = cw.parse_playlist('#EXTINF:-1 tvg-id="Dazn 4 PPV 38 HD" group-title="PPV",Dazn 4\nhttp://s/live/u/p/7.ts\n'
                           '#EXTINF:-1 tvg-id="Baby First" group-title="Kids",Baby First\nhttp://s/live/u/p/8.ts\n')
    web = cw.parse_playlist('#EXTINF:-1 tvg-id="Dazn 4" group-title="PPV",Dazn 4\n/s/7.ts\n'
                            '#EXTINF:-1 tvg-id="BabyFirst.us" group-title="Kids",Baby First\n/s/8.ts\n')
    r = cw.compare(gh, web, {'BabyFirst.us'})
    assert r['epg'] == [('Baby First', '(sin EPG)', 'BabyFirst.us')]


def test_iguales():
    e = cw.parse_playlist(GITHUB)
    r = cw.compare(e, e)
    assert not (r['epg'] or r['name'] or r['group'] or r['only_web']) and r['order_first_diff'] is None
    assert 'Iguales ✅' in cw.report('luis', 'abcdef', r, set())


def _node_ts():
    """Node que corre TypeScript directo (22.18+; la corrida diaria corre los tests antes de
    instalarlo)."""
    return bool(shutil.which('node')) and subprocess.run(
        ['node', '-e', 'process.exit(process.features.typescript ? 0 : 1)'], capture_output=True).returncode == 0


@pytest.mark.skipif(not _node_ts(), reason='hace falta Node con TypeScript')
def test_la_playlist_web_sale_del_codigo_del_worker(tmp_path):
    """tools/web_playlist.ts usa worker/src/playlist.ts: ediciones, ocultos y orden."""
    cfg = {'version': 1, 'provider': {'type': 'xtream', 'servers': ['http://s']},
           'channels': {'ESPN': {'epg': 'ESPN.ar', 'group': 'Deportes'}, 'Oculto': {'hidden': True}},
           'groups': {'order': ['Deportes', 'Argentina'], 'hidden': []}}
    channels = [
        {'name': 'Telefe', 'category': 'Argentina', 'id': '101', 'ext': 'ts', 'icon': '', 'epgId': None},
        {'name': 'ESPN', 'category': 'Argentina', 'id': '102', 'ext': 'ts', 'icon': '', 'epgId': None},
        {'name': 'Oculto', 'category': 'Argentina', 'id': '103', 'ext': 'ts', 'icon': '', 'epgId': None},
    ]
    e = cw.parse_playlist(cw.web_playlist(cfg, channels, str(tmp_path)))
    assert [(x['id'], x['tvg_id'], x['group']) for x in e] == [('102', 'ESPN.ar', 'Deportes'), ('101', 'Telefe', 'Argentina')]


class _MemR2:
    def __init__(self):
        self.d = {}

    def get(self, k):
        return (self.d[k], None) if k in self.d else None

    def put(self, k, body):
        self.d[k] = body


def test_alerta_solo_con_diferencias_nuevas():
    gh = cw.parse_playlist(GITHUB)
    web = cw.parse_playlist(GITHUB.replace('ESPN.ar', 'ESPN2.ar'))
    r2 = _MemR2()
    keys = cw.diff_keys(cw.compare(gh, web), set())
    assert cw.new_since_last(r2, 'cfg', keys) is None, 'la primera vez es la referencia'
    assert cw.new_since_last(r2, 'cfg', keys) == [], 'las mismas de siempre no avisan'
    web2 = cw.parse_playlist(GITHUB.replace('ESPN.ar', 'ESPN2.ar').replace('Telefe.ar', 'Otro.ar'))
    new = cw.new_since_last(r2, 'cfg', cw.diff_keys(cw.compare(gh, web2), set()))
    assert new == ['epg|Telefe|Telefe.ar|Otro.ar']
