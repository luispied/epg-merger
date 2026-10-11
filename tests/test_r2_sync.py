"""Tests de tools/r2_sync.py: solo se sube lo que cambió."""
import gzip
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import r2_sync  # noqa: E402
from fake_s3 import FakeS3  # noqa: E402


def test_sube_solo_lo_que_cambio_y_borra_lo_que_no_esta(tmp_path):
    d = tmp_path / 'map'
    d.mkdir()
    (d / 'a.json').write_text('{"a":1}')
    (d / 'b.json').write_text('{"b":1}')
    s3 = FakeS3()
    s3.objects['img/map/viejo.json'] = (b'{}', {})
    s3.objects['img/mapas.json'] = (b'{}', {})  # otro prefijo: no se toca
    assert r2_sync.sync(s3, 'b', str(d), 'img/map', 'application/json', gz=True, delete=True) == (2, 0, 1)
    body, extra = s3.objects['img/map/a.json']
    assert gzip.decompress(body) == b'{"a":1}'
    assert extra == {'ContentType': 'application/json', 'ContentEncoding': 'gzip'}
    assert 'img/map/viejo.json' not in s3.objects and 'img/mapas.json' in s3.objects

    # Otra corrida con lo mismo y un cambio: se sube solo el cambio.
    s3.puts.clear()
    (d / 'b.json').write_text('{"b":2}')
    assert r2_sync.sync(s3, 'b', str(d), 'img/map', 'application/json', gz=True, delete=True) == (1, 1, 0)
    assert s3.puts == ['img/map/b.json']


def test_un_archivo_y_ya_comprimido(tmp_path):
    f = tmp_path / 'index.json'
    f.write_text('{"channels":[]}')
    s3 = FakeS3()
    assert r2_sync.sync(s3, 'b', str(f), 'guide/index.json', 'application/json', gz=True) == (1, 0, 0)
    assert r2_sync.sync(s3, 'b', str(f), 'guide/index.json', 'application/json', gz=True) == (0, 1, 0)
    h = tmp_path / 'hour'
    h.mkdir()
    (h / '2026101119.json').write_bytes(gzip.compress(b'{}', mtime=0))
    assert r2_sync.sync(s3, 'b', str(h), 'ui/schedule/hour', 'application/json', encoding='gzip') == (1, 0, 0)
    body, extra = s3.objects['ui/schedule/hour/2026101119.json']
    assert gzip.decompress(body) == b'{}' and extra['ContentEncoding'] == 'gzip'
