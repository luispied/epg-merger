"""tools/pedir_medicion.py: pedir a mano la medición de canales (healthreq/ en R2)."""
import datetime
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

from pedir_medicion import pedir_medicion  # noqa: E402

AHORA = datetime.datetime(2026, 11, 6, 1, 0, tzinfo=datetime.timezone.utc)


class MemR2:
    def __init__(self, d):
        self.d = dict(d)

    def keys(self, prefix):
        return [k for k in sorted(self.d) if k.startswith(prefix)]

    def put(self, k, body):
        self.d[k] = body


def test_pide_todas_las_configs_con_dispositivos_y_no_toca_lo_demas():
    r2 = MemR2({'devices/aaa111.json': b'{}', 'devices/bbb222.json': b'{}', 'short/x.json': b'{}',
                'cfg/aaa111.json': b'{}', 'health/aaa111.json': b'{"checked":"2026-11-05T10:00:00Z"}'})
    ids = pedir_medicion(r2, AHORA)
    assert ids == ['aaa111', 'bbb222']
    assert json.loads(r2.d['healthreq/aaa111.json']) == {'at': '2026-11-06T01:00:00Z'}
    assert 'healthreq/bbb222.json' in r2.d
    assert r2.d['short/x.json'] == b'{}'
    assert r2.d['health/aaa111.json'] == b'{"checked":"2026-11-05T10:00:00Z"}'
    assert 'devices/aaa111.json' in r2.d


def test_con_prefijo_pide_solo_esa():
    r2 = MemR2({'devices/aaa111.json': b'{}', 'devices/bbb222.json': b'{}'})
    assert pedir_medicion(r2, AHORA, 'bbb2') == ['bbb222']
    assert 'healthreq/aaa111.json' not in r2.d


def test_prefijo_ambiguo_o_corto_es_error_y_no_escribe():
    r2 = MemR2({'devices/aaa111.json': b'{}', 'devices/aaa222.json': b'{}'})
    with pytest.raises(ValueError):
        pedir_medicion(r2, AHORA, 'aaa')
    with pytest.raises(ValueError):
        pedir_medicion(r2, AHORA, 'aa')
    assert not [k for k in r2.d if k.startswith('healthreq/')]


def test_sin_configuraciones_es_error():
    with pytest.raises(ValueError):
        pedir_medicion(MemR2({}), AHORA)


def test_remedir_marca_el_pedido_y_sin_remedir_no():
    r2 = MemR2({'devices/aaa111.json': b'{}'})
    pedir_medicion(r2, AHORA)
    assert json.loads(r2.d['healthreq/aaa111.json']) == {'at': '2026-11-06T01:00:00Z'}
    pedir_medicion(r2, AHORA, remedir=True)
    assert json.loads(r2.d['healthreq/aaa111.json']) == {'at': '2026-11-06T01:00:00Z', 'remedir': True}
