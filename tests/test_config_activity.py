"""Qué configuraciones de Grilla web no se usan (tools/config_activity.py) y la guía que se salta por eso."""
import datetime
import gzip
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import config_activity  # noqa: E402
import config_epgs  # noqa: E402

NOW = datetime.datetime(2026, 10, 12, 12, tzinfo=datetime.timezone.utc)


def dias(n):
    return NOW - datetime.timedelta(days=n)


def test_ultimo_uso_por_configuracion_y_basura_ignorada():
    recs = [
        {'cfgId': 'a', 'lastUsed': '2026-10-01T10:00:00.000Z'},
        {'cfgId': 'a', 'lastUsed': '2026-10-05T10:00:00.000Z'},
        {'cfgId': 'b'},                                   # nunca usado
        {'cfgId': 'c', 'lastUsed': 'ayer'},               # fecha que no se entiende
        'no es un dict',
    ]
    last = config_activity.last_used_by_config(recs)
    assert last == {'a': datetime.datetime(2026, 10, 5, 10, tzinfo=datetime.timezone.utc)}


def test_sin_edicion_ni_uso_en_30_dias_es_sin_uso():
    modified = {'vieja': dias(45), 'editada-hoy': dias(1), 'usada': dias(60), 'justo': dias(30)}
    last = {'usada': dias(2)}
    # 'usada' se editó hace 60 días pero un link suyo se usó ayer: en uso. 'justo' cumple 30 días: en uso.
    assert config_activity.idle_configs(modified, last, NOW) == ['vieja']


def test_sin_fecha_de_edicion_ni_uso_cuenta_como_sin_uso():
    assert config_activity.idle_configs({'x': None}, {}, NOW) == ['x']
    assert config_activity.idle_configs({'x': None}, {'x': dias(3)}, NOW) == []


def test_build_salta_las_configuraciones_sin_uso(tmp_path):
    merged = tmp_path / 'merged.xml.gz'
    merged.write_bytes(gzip.compress(b'<tv><channel id="ESPN.ar"><display-name>ESPN</display-name></channel></tv>'))
    configs = {'activa': {'channels': {'ESPN': {'epg': 'ESPN.ar'}}},
               'sinuso': {'channels': {'ESPN': {'epg': 'ESPN.ar'}}}}
    stats = config_epgs.build(configs, str(merged), str(tmp_path / 'out'), skip={'sinuso'})
    assert set(stats) == {'activa'}
    assert (tmp_path / 'out' / 'activa.xml.gz').exists() and not (tmp_path / 'out' / 'sinuso.xml.gz').exists()


def test_load_idle_sin_archivo_no_salta_ninguna(tmp_path):
    assert config_epgs.load_idle(str(tmp_path / 'no-existe.json')) == set()
    (tmp_path / 'idle.json').write_text(json.dumps({'days': 30, 'configs': ['x', 'y'], 'total': 3}))
    assert config_epgs.load_idle(str(tmp_path / 'idle.json')) == {'x', 'y'}
    (tmp_path / 'roto.json').write_text('{')
    assert config_epgs.load_idle(str(tmp_path / 'roto.json')) == set()
