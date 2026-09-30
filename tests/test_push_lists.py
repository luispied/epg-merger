"""Lista del proveedor para Grilla web desde GitHub (tools/push_lists.py)."""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import push_lists  # noqa: E402

NOW = datetime.datetime(2026, 9, 30, 12, 0, tzinfo=datetime.timezone.utc)


class FakeR2:
    def __init__(self):
        self.data = {}

    def get(self, key):
        return self.data.get(key)

    def put(self, key, body, when=NOW):
        self.data[key] = (body, when)


PROFILE = {'name': 'luis', 'servers': ['http://s1'], 'username': 'user', 'password': 'secreta'}


def test_huella_igual_que_el_worker():
    # worker/src/link.ts: sha256("grilla-link\n" + usuario + "\n" + clave)
    import hashlib
    assert push_lists.link_hash('user', 'pa ss') == hashlib.sha256(b'grilla-link\nuser\npa ss').hexdigest()


def test_canales_sin_urls_ni_credenciales():
    streams = [
        {'name': 'AR| Telefe', 'stream_id': 10, 'category_id': 1, 'stream_icon': 'http://i', 'epg_channel_id': 'telefe.ar'},
        {'name': 'Evento', 'stream_id': '12', 'category_id': '9', 'container_extension': 'ts'},
        {'name': 'Roto', 'stream_id': None},
    ]
    assert push_lists.worker_channels(streams, {'1': 'Argentina'}) == [
        {'name': 'AR| Telefe', 'category': 'Argentina', 'id': '10', 'ext': 'm3u8', 'icon': 'http://i', 'epgId': 'telefe.ar'},
        {'name': 'Evento', 'category': 'General', 'id': '12', 'ext': 'ts', 'icon': '', 'epgId': None},
    ]


def test_anota_la_cuenta_y_sube_la_lista_de_las_configuraciones_pendientes():
    r2 = FakeR2()
    h = push_lists.link_hash('user', 'secreta')
    calls = []

    def load(profile):
        calls.append(profile['name'])
        return [{'name': 'A', 'category': 'X', 'id': '1', 'ext': 'ts', 'icon': '', 'epgId': None}]

    # Sin configuración anotada: solo avisa que conoce la cuenta.
    assert push_lists.sync(r2, [PROFILE], load, NOW) == {}
    assert f'known/{h}' in r2.data and not calls

    r2.put('cfg/abc.json', b'{}')
    r2.put(f'links/{h}.json', json.dumps({'cfgIds': ['abc', 'borrada'], 'pending': True}).encode())
    assert push_lists.sync(r2, [PROFILE], load, NOW) == {'luis': 1}
    saved = r2.data['list/abc.json'][0].decode()
    assert json.loads(saved)['channels'][0]['name'] == 'A'
    assert 'secreta' not in saved and 'list/borrada.json' not in r2.data
    assert json.loads(r2.data[f'links/{h}.json'][0]) == {'cfgIds': ['abc'], 'pending': False}

    # Recién subida: no se vuelve a bajar hasta que pasen 3 horas.
    assert push_lists.sync(r2, [PROFILE], load, NOW + datetime.timedelta(hours=1)) == {}
    assert push_lists.sync(r2, [PROFILE], load, NOW + datetime.timedelta(hours=3)) == {'luis': 1}
    assert calls == ['luis', 'luis']
