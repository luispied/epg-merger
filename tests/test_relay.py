import json
import os
import sys
import threading
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'relay'))

import pytest  # noqa: E402

import server  # noqa: E402
import xtream_client  # noqa: E402

PUBLIC = lambda host, _p: [(2, 1, 6, '', ('93.184.216.34', 0))]  # noqa: E731


def creds(**extra):
    return {'servers': ['http://prov.example:8080'], 'username': 'user', 'password': 'secreta', **extra}


def test_hosts_privados_o_locales_no_se_permiten():
    for ip in ('127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::1', '0.0.0.0'):
        resolve = lambda h, p, ip=ip: [(2, 1, 6, '', (ip, 0))]  # noqa: E731
        assert server.is_public_host('x', resolve) is False
    assert server.is_public_host('x', PUBLIC) is True
    assert server.is_public_host('x', lambda h, p: (_ for _ in ()).throw(OSError())) is False


def test_validacion_de_servidores_y_credenciales():
    assert server.clean_credentials(creds(), PUBLIC) == (['http://prov.example:8080'], 'user', 'secreta')
    bad = [
        creds(servers=[]), creds(servers=['ftp://x.example']), creds(servers=['http://u:p@x.example']),
        creds(servers=['http://x.example/?username=a']), creds(username=''), creds(password=None),
    ]
    for body in bad:
        with pytest.raises(server.BadRequest):
            server.clean_credentials(body, PUBLIC)
    with pytest.raises(server.BadRequest):
        server.clean_credentials(creds(), lambda h, p: [(2, 1, 6, '', ('10.0.0.1', 0))])


def test_autorizacion_por_secret():
    assert server.authorized('Bearer abc', 'abc') is True
    assert server.authorized('Bearer abd', 'abc') is False
    assert server.authorized('', 'abc') is False
    assert server.authorized('Bearer ', '') is False


def test_el_secret_tiene_que_ser_largo():
    with pytest.raises(SystemExit):
        server.make_server('corto')


def test_probe_prueba_en_orden_y_corta_si_la_cuenta_rechaza():
    seen = []

    def prober(url):
        seen.append(url)
        return 'down' if url.endswith('/2.ts') else 'up'

    out = server.do_probe(['http://s1'], 'user', 'secreta', [{'id': '1', 'ext': 'ts'}, {'id': '2', 'ext': 'ts'}],
                          pick=lambda *a: ('http://s1', {'status': 'Active'}), prober=prober)
    assert out == {'server': 'http://s1', 'account': {'status': 'Active'}, 'results': {'1': 'up', '2': 'down'}, 'aborted': False}
    out = server.do_probe(['http://s1'], 'user', 'secreta', [{'id': str(i), 'ext': 'ts'} for i in range(10)],
                          pick=lambda *a: ('http://s1', None), prober=lambda u: 'rejected')
    assert out['aborted'] is True and out['results'] == {}
    for bad in ([], [{'id': ''}], [{'id': '1', 'ext': '../x'}], [{'id': str(i)} for i in range(server.MAX_PROBE_CHANNELS + 1)]):
        with pytest.raises(server.BadRequest):
            server.do_probe(['http://s1'], 'u', 'p', bad, pick=lambda *a: ('http://s1', None))


def test_probe_respeta_el_tope_de_tiempo():
    ticks = iter(range(0, 1000, 20))
    out = server.do_probe(['http://s1'], 'u', 'p', [{'id': str(i), 'ext': 'ts'} for i in range(10)],
                          pick=lambda *a: ('http://s1', None), prober=lambda u: 'up', clock=lambda: next(ticks), budget_s=45)
    assert 0 < len(out['results']) < 10


def test_http_de_punta_a_punta(monkeypatch):
    monkeypatch.setattr(server, 'do_list', lambda s, u, p: {'server': s[0], 'channels': [{'name': 'A', 'id': '1'}]})
    srv = server.make_server('s' * 40, host='127.0.0.1', port=0)
    srv.RequestHandlerClass.resolve = staticmethod(PUBLIC)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{srv.server_address[1]}'

    def post(path, body, token='s' * 40):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method='POST',
                                     headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    try:
        assert json.loads(urllib.request.urlopen(base + '/health').read()) == {'ok': True}
        assert post('/v1/list', creds())[0] == 200
        assert post('/v1/list', creds())[1]['channels'][0]['id'] == '1'
        assert post('/v1/list', creds(), token='mal')[0] == 401
        assert post('/v1/otro', creds())[0] == 404
        assert post('/v1/list', creds(servers=['http://u:p@x.example']))[0] == 400
    finally:
        srv.shutdown()


def test_probe_provider_distingue_alcanzable_de_bloqueado():
    import probe_provider as pp

    class R:
        def __init__(self, status, text):
            self.status_code, self.text = status, text

    api = json.dumps({'user_info': {'auth': 0}})
    assert pp.classify(200, api)[0] == 'alcanzable'
    assert pp.classify(401, api)[0] == 'alcanzable'
    assert pp.classify(200, '<html>blocked</html>')[0] == 'dudoso'
    assert pp.classify(403, '')[0] == 'bloqueado'
    assert pp.classify(503, '')[0] == 'dudoso'
    assert pp.probe('http://x.example/', get=lambda *a, **k: R(200, api))['result'] == 'alcanzable'

    def refused(*a, **k):
        raise pp.requests.exceptions.ConnectionError()

    def slow(*a, **k):
        raise pp.requests.exceptions.ConnectTimeout()

    assert pp.probe('http://x.example', get=refused)['result'] == 'bloqueado'
    assert pp.probe('http://x.example', get=slow)['result'] == 'bloqueado'


def test_el_relay_no_escribe_credenciales_en_el_log(monkeypatch, capsys):
    import xtream_client

    def boom(url, params=None, timeout=None):
        raise xtream_client.requests.RequestException(f"403 Client Error: Forbidden for url: {url}?username={params['username']}&password={params['password']}")

    monkeypatch.setattr(xtream_client.requests, 'get', boom)
    with pytest.raises(xtream_client.XtreamError):
        server.do_list(['http://prov.example:8080'], 'usuario_x', 'clave_secreta')
    out = capsys.readouterr()
    assert 'clave_secreta' not in out.out + out.err and 'usuario_x' not in out.out + out.err
    assert 'prov.example' not in out.out + out.err


def test_canales_sin_urls_ni_credenciales():
    streams = [
        {'name': 'AR| Telefe', 'stream_id': 10, 'category_id': 1, 'stream_icon': 'http://i', 'epg_channel_id': 'telefe.ar'},
        {'name': 'Evento', 'stream_id': '12', 'category_id': '9', 'container_extension': 'ts'},
        {'name': 'Roto', 'stream_id': None},
    ]
    assert xtream_client.worker_channels(streams, {'1': 'Argentina'}) == [
        {'name': 'AR| Telefe', 'category': 'Argentina', 'id': '10', 'ext': 'm3u8', 'icon': 'http://i', 'epgId': 'telefe.ar'},
        {'name': 'Evento', 'category': 'General', 'id': '12', 'ext': 'ts', 'icon': '', 'epgId': None},
    ]


def test_datos_de_la_cuenta_solo_con_lista_blanca():
    data = {'user_info': {'username': 'user', 'password': 'secreta', 'status': 'Active', 'exp_date': '1793836800',
                          'is_trial': '0', 'max_connections': '2', 'active_cons': '1'}, 'server_info': {'url': 'x'}}
    info = xtream_client.account_info(data)
    assert info == {'status': 'Active', 'expires': '2026-11-05T00:00:00+00:00', 'trial': False, 'maxConnections': 2, 'activeConnections': 1}
    assert 'secreta' not in json.dumps(info) and 'user' not in json.dumps(info).replace('trial', '')
    assert xtream_client.account_info({'user_info': {'exp_date': None}})['expires'] is None
    assert xtream_client.account_info({'user_info': {'exp_date': '0'}})['expires'] is None
    assert xtream_client.account_info({'algo': 1}) is None and xtream_client.account_info(None) is None


def test_datos_de_la_cuenta_traen_la_zona_horaria_del_panel():
    info = xtream_client.account_info({'user_info': {}, 'server_info': {'timezone': 'America/Bogota', 'url': 'x'}})
    assert info['timezone'] == 'America/Bogota'
    for raro in ('', '<script>', 'a' * 70, 123, '../../etc'):
        assert 'timezone' not in xtream_client.account_info({'user_info': {}, 'server_info': {'timezone': raro}})
