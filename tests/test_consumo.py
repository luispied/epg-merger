"""tools/consumo.py: el registro diario de cuánto consumen los servidores."""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import consumo  # noqa: E402

DAY = datetime.date(2026, 10, 10)


class Resp:
    def __init__(self, data):
        self.data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


def test_clases_de_r2():
    rows = [{'dimensions': {'actionType': t}, 'sum': {'requests': n}}
            for t, n in [('GetObject', 10), ('HeadObject', 5), ('PutObject', 3), ('ListObjects', 2), ('DeleteObject', 99)]]
    assert consumo.r2_classes(rows) == (5, 15)


def test_cloudflare_suma_y_pasa_cpu_a_ms():
    seen = {}

    def post(url, json, headers, timeout):
        seen.update(json['variables'])
        return Resp({'data': {'viewer': {'accounts': [{
            'worker': [{'sum': {'requests': 100, 'errors': 2, 'subrequests': 7}, 'quantiles': {'cpuTimeP50': 1500, 'cpuTimeP99': 4200}},
                       {'sum': {'requests': 50, 'errors': 0, 'subrequests': 1}, 'quantiles': {'cpuTimeP50': 900, 'cpuTimeP99': 8000}}],
            'r2': [{'dimensions': {'actionType': 'GetObject'}, 'sum': {'requests': 40}},
                   {'dimensions': {'actionType': 'PutObject'}, 'sum': {'requests': 4}}],
        }]}}})
    out = consumo.cloudflare('t', 'acct', DAY, post=post)
    assert out == {'worker_requests': 150, 'worker_errors': 2, 'worker_subrequests': 8, 'worker_cpu_p50_ms': 1.5,
                   'worker_cpu_p99_ms': 8.0, 'r2_class_a_month': 4, 'r2_class_b_month': 40}
    assert seen['dayFrom'] == '2026-10-10T00:00:00Z' and seen['dayTo'] == '2026-10-11T00:00:00Z'
    assert seen['monthFrom'] == '2026-10-01T00:00:00Z'


def test_cloudflare_con_errores_falla():
    post = lambda *a, **k: Resp({'errors': [{'message': 'sin permiso'}]})  # noqa: E731
    try:
        consumo.cloudflare('t', 'acct', DAY, post=post)
    except RuntimeError as e:
        assert 'sin permiso' in str(e)
    else:
        raise AssertionError('debió fallar')


def test_fly_usa_las_horas_del_mes():
    exprs = []

    def get(url, params, headers, timeout):
        exprs.append(params['query'])
        return Resp({'data': {'result': [{'value': [0, '1000.4']}, {'value': [0, '1']}]}})
    out = consumo.fly('t', DAY, get=get)
    assert out['fly_out_bytes'] == 1001
    assert any('[240h]' in e for e in exprs)  # del 1 al 10 inclusive


def test_historial_ida_y_vuelta():
    hist = consumo.merge_row(consumo.load_history(''), {'date': '2026-10-09', 'worker_requests': 1})
    hist = consumo.merge_row(hist, {'date': '2026-10-10', 'worker_requests': 2, 'worker_cpu_p99_ms': 3.0})
    hist = consumo.merge_row(hist, {'date': '2026-10-10', 'worker_requests': 5, 'worker_cpu_p99_ms': 3.0})
    body = consumo.render(hist, ['Sin `FLY_READ_TOKEN`: falta el tráfico del relay.'])
    back = consumo.load_history(body)
    assert [r['worker_requests'] for r in back['rows']] == [1, 5]
    assert 'FLY_READ_TOKEN' in body and '| 2026-10-10 | 5 |' in body


def test_historial_roto_empieza_de_cero():
    assert consumo.load_history('<!-- consumo:{no es json -->') == {'rows': [], 'warned': {}}


def test_avisa_una_vez_por_mes():
    row = {'date': '2026-10-10', 'r2_bytes': 8 * 1000 ** 3}
    hist = {'rows': [row], 'warned': {}}
    assert [w[0] for w in consumo.new_warnings(hist, row)] == ['r2_storage_bytes']
    hist['warned']['r2_storage_bytes'] = '2026-10'
    assert consumo.new_warnings(hist, row) == []
    nov = {**row, 'date': '2026-11-01'}
    assert [w[0] for w in consumo.new_warnings(hist, nov)] == ['r2_storage_bytes']
    assert consumo.new_warnings({'rows': [], 'warned': {}}, {'date': '2026-10-10', 'r2_bytes': 10}) == []


def test_sin_credenciales_lo_dice():
    row, notes = consumo.collect(DAY, {})
    assert row == {'date': '2026-10-10'}
    assert any('CLOUDFLARE_ANALYTICS_TOKEN' in n for n in notes) and any('FLY_READ_TOKEN' in n for n in notes)


def test_human():
    assert consumo.human('r2_bytes', 2_500_000) == '2.5 MB'
    assert consumo.human('worker_requests', 123456) == '123.456'


def test_fly_manda_el_token_flyv1_tal_cual():
    seen = []

    def get(url, params, headers, timeout):
        seen.append(headers['Authorization'])
        return Resp({'data': {'result': []}})
    consumo.fly('FlyV1 fm2_abc,fm2_def\n', DAY, get=get)
    consumo.fly('viejo', DAY, get=get)
    assert seen[0] == 'FlyV1 fm2_abc,fm2_def' and seen[-1] == 'Bearer viejo'
