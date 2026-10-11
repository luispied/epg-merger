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


def test_indice_por_hora_de_cada_configuracion(tmp_path):
    from source_alias import channel_alias
    src, dst = tmp_path / 'schedule', tmp_path / 'cfg'
    (src / 'hour').mkdir(parents=True)
    alias = channel_alias('Teledoce.uy')
    index = {'h': 100, 't': ['Noticias', 'Fútbol', 'Otra'],
             'c': {alias: [[0, 30, 0], [30, 60, 1]], 'g0000000000000a.ar': [[0, 60, 2]], 'g0000000000000b.us': [[0, 60, 1]]}}
    (src / 'hour' / '2026101119.json').write_text(json.dumps(index), encoding='utf-8')
    (src / 'hour' / '2026101119-d.json').write_text('{"d":[],"c":{}}', encoding='utf-8')
    # Una configuración vieja guarda el id real; una nueva, el alias.
    configs = {'viejo': {'channels': {'Teledoce': {'epg': 'Teledoce.uy'}, 'B': {'epg': 'g0000000000000b.us'}}},
               'nuevo': {'channels': {'A': {'epg': 'g0000000000000a.ar'}, 'Sin guía': {'epg': None}}}}
    assert ps.pack_configs(configs, str(src), str(dst)) == 2
    assert sorted(os.listdir(dst)) == ['nuevo', 'viejo']
    assert read_channel_from(dst / 'viejo', '2026101119') == {
        'h': 100, 't': ['Fútbol', 'Noticias'], 'c': {'g0000000000000b.us': [[0, 60, 0]], alias: [[0, 30, 1], [30, 60, 0]]}}
    assert read_channel_from(dst / 'nuevo', '2026101119') == {'h': 100, 't': ['Otra'], 'c': {'g0000000000000a.ar': [[0, 60, 0]]}}


def read_channel_from(path, name):
    data = path.read_bytes()
    n = int(data[:8])
    start, length = json.loads(data[8:8 + n])[name]
    return json.loads(gzip.decompress(data[8 + n + start:8 + n + start + length]))


def test_indices_por_hora_desde_el_merged(tmp_path):
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc).replace(minute=0, second=0, microsecond=0)
    fmt = lambda t: t.strftime('%Y%m%d%H%M%S +0000')  # noqa: E731
    merged = tmp_path / 'merged.xml.gz'
    with gzip.open(merged, 'wt', encoding='utf-8') as f:
        f.write(f'<tv><channel id="Teledoce.uy"><display-name>Teledoce</display-name></channel>'
                f'<programme channel="Teledoce.uy" start="{fmt(now)}" stop="{fmt(now + datetime.timedelta(hours=1))}">'
                f'<title>Telemundo</title></programme></tv>')
    src = ps.hours_from_merged(str(merged), str(tmp_path / 'schedule'))
    configs = {'c': {'channels': {'Teledoce': {'epg': 'Teledoce.uy'}}}}
    ps.pack_configs(configs, src, str(tmp_path / 'cfg'))
    index = read_channel_from(tmp_path / 'cfg' / 'c', now.strftime('%Y%m%d%H'))
    assert index['t'] == ['Telemundo'] and list(index['c'].values()) == [[[0, 60, 0]]]
