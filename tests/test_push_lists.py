"""Subida de la lista del proveedor al Worker (tools/push_lists.py) y el campo 'grilla' de los perfiles."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import push_lists  # noqa: E402
from profiles import load_profiles  # noqa: E402


def test_perfil_con_configuracion_de_grilla():
    env = {'XTREAM_PROFILES': json.dumps({'servers': ['http://s1'], 'profiles': [
        {'name': 'luis', 'username': 'u', 'password': 'p', 'grilla': {'cfg': 'abc', 'key': 'k'}},
        {'name': 'paola', 'username': 'u2', 'password': 'p2'},
        {'name': 'rota', 'username': 'u3', 'password': 'p3', 'grilla': {'cfg': 'abc'}},
    ]})}
    profiles = {p['name']: p for p in load_profiles(env)}
    assert profiles['luis']['grilla'] == {'cfg': 'abc', 'key': 'k'}
    assert profiles['paola']['grilla'] is None
    assert profiles['rota']['grilla'] is None


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


def test_sube_al_worker_con_la_clave_de_edicion(monkeypatch):
    monkeypatch.setattr(push_lists, 'get_live_streams', lambda servers, u, p: ('http://s1', [
        {'name': 'A', 'stream_id': 1, 'category_id': 1}]))
    monkeypatch.setattr(push_lists, 'get_live_categories', lambda server, u, p: {'1': 'Cat'})
    sent = {}

    class Session:
        def put(self, url, **kw):
            sent.update(url=url, **kw)
            return type('R', (), {'ok': True, 'status_code': 200, 'text': ''})()

    profile = {'name': 'luis', 'servers': ['http://s1'], 'username': 'user', 'password': 'secreta',
               'grilla': {'cfg': 'abc', 'key': 'clave'}}
    assert push_lists.push(profile, 'https://w', Session()) == 1
    assert sent['url'] == 'https://w/api/cfg/abc/list'
    assert sent['headers'] == {'Authorization': 'Bearer clave'}
    assert 'secreta' not in json.dumps(sent['json']) and 'user' not in json.dumps(sent['json'])
