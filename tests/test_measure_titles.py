"""Tests de tools/measure_titles.py (sin red ni R2)."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import measure_titles as mt  # noqa: E402
from source_alias import channel_alias  # noqa: E402

H = 3600


def write(tmp, epg, entries):
    with open(os.path.join(tmp, mt.schedule_file(epg) + '.json'), 'w', encoding='utf-8') as f:
        json.dump(entries, f)


def guide(tmp, extra=()):
    write(tmp, 'Teledoce.uy', [
        [0, H, 'Telemundo', 'El noticiero central con todo lo del día.'],
        [H, 2 * H, 'TELEMUNDO  ', 'Una descripción bastante más larga del noticiero de la noche.'],
        [2 * H, 2 * H + 240, 'Avance'],             # menos de 5 minutos: no es un programa
        [3 * H, 4 * H, 'Programa pagado'],          # genérico
        [4 * H, 5 * H, 'Infomercial de cuchillos'],  # relleno
    ])
    write(tmp, 'Canal10.uy', [[0, 2 * H, 'Peñarol vs. Nacional', 'Clásico del fútbol uruguayo.'], *extra])
    write(tmp, 'ESPN.ar', [[0, 2 * H, 'SportsCenter']])


def test_collect_dedupe_genericos_y_tu_noche(tmp_path):
    guide(str(tmp_path))
    titles = mt.collect(str(tmp_path))
    by = {v[0]: v for v in titles.values()}
    assert set(by) == {'Telemundo', 'Avance', 'Peñarol vs. Nacional', 'SportsCenter'}
    # Mismo título con otras mayúsculas y espacios: uno solo, con la descripción más larga.
    assert by['Telemundo'][1].startswith('Una descripción bastante')
    assert by['Avance'][2] is False and by['Telemundo'][2] is True
    assert by['Telemundo'][4] == 2 and by['SportsCenter'][4] == 1   # emisiones


def test_canales_en_uso_por_alias_o_id_viejo(tmp_path):
    guide(str(tmp_path))
    configs = {'a': {'channels': {'Diez': {'epg': channel_alias('Canal10.uy')}}},
               'b': {'channels': {'ESPN': {'epg': 'ESPN.ar'}, 'Otro': {'epg': None}, 'X': {}}}}
    titles = mt.collect(str(tmp_path), mt.used_files(configs))
    assert sorted(v[0] for v in titles.values()) == ['Peñarol vs. Nacional', 'SportsCenter']
    # El peso es cuántas configuraciones usan el canal.
    assert mt.used_files(configs) == {mt.schedule_file('Canal10.uy'): 1, mt.schedule_file('ESPN.ar'): 1}
    configs['c'] = {'channels': {'X': {'epg': 'ESPN.ar'}, 'Y': {'epg': 'ESPN.ar'}}}
    weights = {v[0]: v[3] for v in mt.collect(str(tmp_path), mt.used_files(configs)).values()}
    assert weights == {'Peñarol vs. Nacional': 1, 'SportsCenter': 2}


def test_programas_cortos_de_5_minutos_o_mas_se_clasifican(tmp_path):
    write(str(tmp_path), 'Kids.uy', [[0, 11 * 60, 'Peppa Pig · Ep. 1'], [H, H + 299, 'Sorteo']])
    by = {v[0]: v for v in mt.collect(str(tmp_path)).values()}
    assert by['Peppa Pig · Ep. 1'][2] is True and by['Sorteo'][2] is False


def test_medicion_cuenta_nuevos_de_un_dia_a_otro_y_olvida(tmp_path):
    tmp = str(tmp_path)
    guide(tmp)
    configs = {'a': {'channels': {'Diez': {'epg': 'Canal10.uy'}}}}
    seen = {}
    first = mt.measure(tmp, configs, seen, '2026-10-10')
    assert first['first_run'] and first['all']['plan_titles'] == 3 and first['all']['new'] == 4
    assert first['used']['plan_titles'] == 1 and first['all']['backlog_cost'] > 0
    guide(tmp, extra=[[2 * H, 4 * H, 'Película: El secreto de sus ojos', 'Un clásico argentino.']])
    second = mt.measure(tmp, configs, seen, '2026-10-11')
    assert not second['first_run']
    assert second['all']['new_plan'] == 1 and second['used']['new_plan'] == 1
    assert second['used']['samples'] == ['Película: El secreto de sus ojos']
    assert second['all']['new_cost'] > 0
    # A los dos meses sin aparecer, se olvida.
    seen['viejo'] = ['2026-01-01', '2026-01-02']
    mt.update_seen(seen, [], '2026-10-12')
    assert 'viejo' not in seen
    text = mt.summary(second, [first, second])
    assert 'Nuevos hoy' in text and 'Por mes' in text and 'El secreto de sus ojos' in text


def test_costo_por_lotes():
    tin, tout, usd = mt.cost([('Título', 'x' * 1000, True)] * 120)
    # Tres tandas de instrucciones, la descripción recortada y 25 tokens de respuesta por título.
    assert tin == 120 * (mt.tokens('Título') + mt.tokens('x' * mt.DESC_CHARS) + mt.PER_TITLE_OVERHEAD) + 3 * mt.SYSTEM_TOKENS
    assert tout == 120 * mt.OUT_TOKENS
    assert abs(usd - (tin * mt.PRICE_IN + tout * mt.PRICE_OUT)) < 1e-12
    assert mt.cost([]) == (0, 0, 0.0)
