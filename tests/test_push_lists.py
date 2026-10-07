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


def test_el_umbral_de_refresco_por_defecto_es_de_3_horas_y_el_pedido_del_worker_lo_baja():
    assert push_lists.refresh_every({}) == push_lists.REFRESH_EVERY
    assert push_lists.refresh_every({'REFRESH_MINUTES': ''}) == push_lists.REFRESH_EVERY
    assert push_lists.refresh_every({'REFRESH_MINUTES': 'basura'}) == push_lists.REFRESH_EVERY
    assert push_lists.refresh_every({'REFRESH_MINUTES': '10'}) == datetime.timedelta(minutes=9)
    # Nunca menos de 5 minutos ni más de 3 horas.
    assert push_lists.refresh_every({'REFRESH_MINUTES': '1'}) == datetime.timedelta(minutes=4)
    assert push_lists.refresh_every({'REFRESH_MINUTES': '9999'}) == datetime.timedelta(minutes=179)


def test_con_el_umbral_corto_se_baja_una_lista_de_hace_15_minutos_y_con_el_normal_no():
    h = push_lists.link_hash('user', 'secreta')
    loaded = []

    def load(profile):
        loaded.append(1)
        return [{'name': 'A', 'category': 'X', 'id': '1', 'ext': 'ts', 'icon': '', 'epgId': None}]

    def fresh_r2():
        r2 = FakeR2()
        r2.put('cfg/abc.json', b'{}')
        r2.put(f'links/{h}.json', json.dumps({'cfgIds': ['abc'], 'pending': False}).encode())
        r2.put('list/abc.json', b'{"channels": []}', when=NOW - datetime.timedelta(minutes=15))
        return r2

    assert push_lists.sync(fresh_r2(), [PROFILE], load, NOW) == {}
    assert not loaded
    assert push_lists.sync(fresh_r2(), [PROFILE], load, NOW, every=push_lists.refresh_every({'REFRESH_MINUTES': '10'})) == {'luis': 1}
    assert loaded
