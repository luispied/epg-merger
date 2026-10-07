"""Canales caídos para Grilla web (tools/check_streams.py)."""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import check_streams  # noqa: E402
import push_lists  # noqa: E402

NOW = datetime.datetime(2026, 10, 7, 7, 30, tzinfo=datetime.timezone.utc)
LATER = NOW + datetime.timedelta(days=1)


def ch(i, name=None, category='Aire', ext='m3u8'):
    return {'name': name or f'Canal {i}', 'category': category, 'id': str(i), 'ext': ext, 'icon': '', 'epgId': None}


def test_probar_solo_canales_que_valen_la_pena():
    channels = [ch(1), ch(2, category='▆▆▆ DEPORTES ▆▆▆'), ch(3, category='PPV EVENTS'), ch(4), ch(5, category='Oculta'), ch(6, name='Tapado')]
    cfg = {'channels': {'Tapado': {'hidden': True}}, 'groups': {'hidden': ['Oculta']}}
    assert [c['id'] for c in check_streams.visible_channels(channels, cfg)] == ['1', '4']


def test_primero_los_nunca_probados_y_despues_los_mas_viejos():
    channels = [ch(i) for i in range(1, 6)]
    state = {'channels': {'1': {'t': '2026-10-07T07:00:00'}, '2': {'t': '2026-10-05T07:00:00'}, '3': {'t': '2026-10-06T07:00:00'}}}
    assert [c['id'] for c in check_streams.pick_batch(channels, state, 4)] == ['4', '5', '2', '3']


def test_dos_fallas_seguidas_y_se_recupera_si_vuelve():
    channels = [ch(1), ch(2)]
    prober = lambda url: 'down' if url.endswith('/1') else 'up'
    first = check_streams.check(channels, {}, lambda c: f"http://s/{c['id']}", prober, NOW)
    assert first['channels']['1'] == {'t': NOW.isoformat(timespec='seconds'), 'ok': False, 'fails': 1}
    assert first['channels']['2']['ok'] and first['tested'] == 2
    second = check_streams.check(channels, first, lambda c: f"http://s/{c['id']}", prober, LATER)
    assert second['channels']['1']['fails'] == 2
    healed = check_streams.check(channels, second, lambda c: f"http://s/{c['id']}", lambda url: 'up', LATER)
    assert healed['channels']['1'] == {'t': LATER.isoformat(timespec='seconds'), 'ok': True, 'fails': 0}


def test_quita_lo_que_ya_no_esta_en_la_lista():
    state = {'channels': {'9': {'t': 'x', 'ok': False, 'fails': 3}}}
    new = check_streams.check([ch(1)], state, lambda c: 'http://s/1', lambda url: 'up', NOW)
    assert set(new['channels']) == {'1'}


def test_si_la_cuenta_rechaza_no_anota_nada():
    channels = [ch(i) for i in range(1, 10)]
    assert check_streams.check(channels, {}, lambda c: 'http://s', lambda url: 'rejected', NOW) is None


def test_corta_por_tiempo():
    ticks = iter(range(0, 1000, 100))
    new = check_streams.check([ch(i) for i in range(1, 20)], {}, lambda c: 'http://s', lambda url: 'up', NOW, budget_s=250, clock=lambda: next(ticks))
    assert 0 < new['tested'] < 19


class FakeR2:
    def __init__(self):
        self.data = {}

    def get(self, key):
        return self.data.get(key)

    def put(self, key, body):
        self.data[key] = (body, NOW)


def test_corrida_completa_deja_health_en_cada_configuracion_de_la_cuenta():
    profile = {'name': 'luis', 'servers': ['http://s1'], 'username': 'user', 'password': 'secreta'}
    h = push_lists.link_hash('user', 'secreta')
    r2 = FakeR2()
    r2.put('cfg/a.json', b'{}')
    r2.put('cfg/b.json', b'{}')
    r2.put(f'links/{h}.json', json.dumps({'cfgIds': ['a', 'b']}).encode())
    r2.put('list/a.json', json.dumps({'channels': [ch(1), ch(2)]}).encode())
    seen = []

    def prober(url):
        seen.append(url)
        return 'down' if url.endswith('/2.m3u8') else 'up'

    done = check_streams.run(r2, [profile], prober, NOW, server_for=lambda *a: 'http://s1')
    assert done == {'luis': (2, 0)}
    assert seen == ['http://s1/live/user/secreta/1.m3u8', 'http://s1/live/user/secreta/2.m3u8']
    for cfg_id in ('a', 'b'):
        data = json.loads(r2.data[f'health/{cfg_id}.json'][0])
        assert data['channels']['2']['ok'] is False and data['channels']['1']['ok'] is True
        assert 'secreta' not in json.dumps(data)


def test_sin_servidor_o_sin_lista_no_hace_nada():
    profile = {'name': 'luis', 'servers': ['http://s1'], 'username': 'user', 'password': 'secreta'}
    h = push_lists.link_hash('user', 'secreta')
    r2 = FakeR2()
    r2.put('cfg/a.json', b'{}')
    r2.put(f'links/{h}.json', json.dumps({'cfgIds': ['a']}).encode())
    assert check_streams.run(r2, [profile], lambda u: 'up', NOW, server_for=lambda *a: 'http://s1') == {}
    r2.put('list/a.json', json.dumps({'channels': [ch(1)]}).encode())
    assert check_streams.run(r2, [profile], lambda u: 'up', NOW, server_for=lambda *a: None) == {}
