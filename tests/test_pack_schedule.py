"""Tests de tools/pack_schedule.py: cada canal se recupera de su tanda con el encabezado."""
import gzip
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import pack_schedule as ps  # noqa: E402


def read_channel(dst, name):
    with open(os.path.join(dst, 's', name[:2]), 'rb') as f:
        data = f.read()
    n = int(data[:8])
    start, length = json.loads(data[8:8 + n])[name]
    return json.loads(gzip.decompress(data[8 + n + start:8 + n + start + length]))


def test_pack_roundtrip(tmp_path):
    src, dst = tmp_path / 'schedule', tmp_path / 'r2'
    (src / 'hour').mkdir(parents=True)
    channels = {
        'ab00000000000001': [[1, 2, 'Uno']],
        'ab00000000000002': [[3, 4, 'Dos', 'Con descripción ñ']],
        'cd00000000000003': [[5, 6, 'Tres']],
    }
    for name, entries in channels.items():
        (src / f'{name}.json').write_text(json.dumps(entries, ensure_ascii=False), encoding='utf-8')
    (src / 'hour' / '2026101119.json').write_text('{"h":1}', encoding='utf-8')
    (dst / 'viejo').mkdir(parents=True)  # lo de una corrida anterior se borra

    assert ps.pack(str(src), str(dst)) == (3, 2, 1)
    assert sorted(os.listdir(dst / 's')) == ['ab', 'cd']
    assert not (dst / 'viejo').exists()
    for name, entries in channels.items():
        assert read_channel(str(dst), name) == entries
    assert gzip.decompress((dst / 'hour' / '2026101119.json').read_bytes()) == b'{"h":1}'


def test_pack_sin_programacion(tmp_path):
    assert ps.main(['x', str(tmp_path / 'nada'), str(tmp_path / 'r2')]) == 0
    assert not (tmp_path / 'r2').exists()
