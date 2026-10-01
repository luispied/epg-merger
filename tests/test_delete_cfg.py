"""tools/delete_cfg.py: borrar una configuración de prueba con todo lo suyo."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

from delete_cfg import delete_config  # noqa: E402


class MemR2:
    def __init__(self, d):
        self.d = dict(d)

    def get(self, k):
        return (self.d[k], None) if k in self.d else None

    def put(self, k, body):
        self.d[k] = body

    def keys(self, prefix):
        return [k for k in sorted(self.d) if k.startswith(prefix)]

    def delete(self, k):
        del self.d[k]


def test_borra_todo_lo_de_la_configuracion_y_nada_mas():
    r2 = MemR2({
        'cfg/-wPXj0aaaaaaaaaa.json': b'{}', 'cfg/0bRZUwbbbbbbbbbb.json': b'{}',
        'list/-wPXj0aaaaaaaaaa.json': b'{}', 'epg/-wPXj0aaaaaaaaaa.xml.gz': b'x',
        'short/abc.json': json.dumps({'cfgId': '-wPXj0aaaaaaaaaa', 'token': 't'}).encode(),
        'short/def.json': json.dumps({'cfgId': '0bRZUwbbbbbbbbbb', 'token': 't'}).encode(),
        'links/h.json': json.dumps({'cfgIds': ['-wPXj0aaaaaaaaaa', '0bRZUwbbbbbbbbbb'], 'pending': False}).encode(),
    })
    cfg_id, _ = delete_config(r2, '-wPXj0')
    assert cfg_id == '-wPXj0aaaaaaaaaa'
    assert sorted(r2.d) == ['cfg/0bRZUwbbbbbbbbbb.json', 'links/h.json', 'short/def.json']
    assert json.loads(r2.d['links/h.json'])['cfgIds'] == ['0bRZUwbbbbbbbbbb']


def test_no_borra_si_el_comienzo_es_ambiguo_o_corto():
    r2 = MemR2({'cfg/abcd1111.json': b'{}', 'cfg/abcd2222.json': b'{}'})
    with pytest.raises(ValueError):
        delete_config(r2, 'abcd')
    with pytest.raises(ValueError):
        delete_config(r2, 'ab')
    assert len(r2.d) == 2
