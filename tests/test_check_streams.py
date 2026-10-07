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

    done = check_streams.run(r2, [profile], prober, NOW, server_for=lambda *a: ('http://s1', None))
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
    assert check_streams.run(r2, [profile], lambda u: 'up', NOW, server_for=lambda *a: ('http://s1', None)) == {}
    r2.put('list/a.json', json.dumps({'channels': [ch(1)]}).encode())
    assert check_streams.run(r2, [profile], lambda u: 'up', NOW, server_for=lambda *a: (None, None)) == {}


def test_datos_de_la_cuenta_solo_con_lista_blanca():
    data = {'user_info': {'username': 'user', 'password': 'secreta', 'status': 'Active', 'exp_date': '1793836800',
                          'is_trial': '0', 'max_connections': '2', 'active_cons': '1'}, 'server_info': {'url': 'x'}}
    info = check_streams.account_info(data)
    assert info == {'status': 'Active', 'expires': '2026-11-05T00:00:00+00:00', 'trial': False, 'maxConnections': 2}
    assert 'secreta' not in json.dumps(info) and 'user' not in json.dumps(info).replace('trial', '')
    assert check_streams.account_info({'user_info': {'exp_date': None}})['expires'] is None
    assert check_streams.account_info({'user_info': {'exp_date': '0'}})['expires'] is None
    assert check_streams.account_info({'algo': 1}) is None and check_streams.account_info(None) is None


def test_la_cuenta_se_publica_aunque_el_proveedor_rechace_las_pruebas():
    profile = {'name': 'luis', 'servers': ['http://s1'], 'username': 'user', 'password': 'secreta'}
    h = push_lists.link_hash('user', 'secreta')
    r2 = FakeR2()
    r2.put('cfg/a.json', b'{}')
    r2.put(f'links/{h}.json', json.dumps({'cfgIds': ['a']}).encode())
    r2.put('list/a.json', json.dumps({'channels': [ch(i) for i in range(1, 10)]}).encode())
    r2.put('health/a.json', json.dumps({'channels': {'1': {'t': 'x', 'ok': True, 'fails': 0}}}).encode())
    account = {'status': 'Active', 'expires': '2026-11-05T00:00:00+00:00', 'trial': False, 'maxConnections': 1}
    check_streams.run(r2, [profile], lambda u: 'rejected', NOW, server_for=lambda *a: ('http://s1', account))
    data = json.loads(r2.data['health/a.json'][0])
    assert data['account'] == account and data['channels'] == {'1': {'t': 'x', 'ok': True, 'fails': 0}}


def test_una_sola_prueba_por_dia_aunque_se_lance_a_mano():
    profile = {'name': 'luis', 'servers': ['http://s1'], 'username': 'user', 'password': 'secreta'}
    h = push_lists.link_hash('user', 'secreta')
    r2 = FakeR2()
    r2.put('cfg/a.json', b'{}')
    r2.put(f'links/{h}.json', json.dumps({'cfgIds': ['a']}).encode())
    r2.put('list/a.json', json.dumps({'channels': [ch(1)]}).encode())
    calls = []

    def prober(url):
        calls.append(url)
        return 'up'

    server = lambda *a: ('http://s1', None)
    first = check_streams.run(r2, [profile], prober, NOW, server_for=server)
    assert first == {'luis': (1, 0)} and len(calls) == 1
    # Cinco horas después (otra corrida, a mano o programada): se saltea.
    assert check_streams.run(r2, [profile], prober, NOW + datetime.timedelta(hours=5), server_for=server) == {}
    assert len(calls) == 1
    # Pasadas las 20 horas, de nuevo.
    assert check_streams.run(r2, [profile], prober, NOW + datetime.timedelta(hours=21), server_for=server) == {'luis': (1, 0)}
    assert len(calls) == 2
    assert check_streams.recent({}, NOW) is False and check_streams.recent({'checked': 'basura'}, NOW) is False
