"""Tests de tools/auto_sources.py (sin red ni R2: las candidatas se entregan ya bajadas)."""
import json
import os
import sys

from lxml import etree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import auto_sources as auto  # noqa: E402
import generate_playlist as gp  # noqa: E402
import merge_epgs  # noqa: E402
from source_alias import channel_alias  # noqa: E402

TODAY = '2026-10-09'
SECTIONS = ([], [], {}, {})
MANUAL = {'ids': {'src-ar'}, 'urls': {'https://x/ar.xml.gz'},
          'active': [{'id': 'src-ar', 'url': 'https://x/ar.xml.gz', 'country': 'ar', 'priority': 0}]}

CATALOG = {
    'cat-uy1': {'id': 'cat-uy1', 'url': 'https://c/uy1.xml.gz', 'country': 'uy', 'status': 'fresh',
                'live_channels': 30, 'size_bytes': 2 * 10**6},
    'cat-uy2': {'id': 'cat-uy2', 'url': 'https://c/uy2.xml.gz', 'country': 'uy', 'status': 'fresh',
                'live_channels': 5, 'size_bytes': 1 * 10**6},
    'cat-uy-big': {'id': 'cat-uy-big', 'url': 'https://c/uybig.xml.gz', 'country': 'uy', 'status': 'fresh',
                   'live_channels': 900, 'size_bytes': 60 * 10**6},
    'cat-tr': {'id': 'cat-tr', 'url': 'https://c/tr.xml.gz', 'country': 'tr', 'status': 'fresh',
               'live_channels': 50, 'size_bytes': 3 * 10**6},
    'cat-ar': {'id': 'cat-ar', 'url': 'https://x/ar.xml.gz', 'country': 'ar', 'status': 'fresh'},
}

UY1 = b'''<?xml version="1.0"?><tv>
<channel id="Teledoce.uy"><display-name>Teledoce</display-name></channel>
<channel id="Canal10.uy"><display-name>Canal 10</display-name></channel>
<programme channel="Teledoce.uy" start="20261009110000 +0000" stop="20261009130000 +0000"><title>x</title></programme>
<programme channel="Canal10.uy" start="20261009110000 +0000" stop="20261009130000 +0000"><title>x</title></programme>
</tv>'''
EMPTY = b'<?xml version="1.0"?><tv></tv>'


def _root(*channels):
    root = etree.Element('tv')
    for cid, name, source in channels:
        ch = etree.SubElement(root, 'channel', id=cid, source=source)
        etree.SubElement(ch, 'display-name').text = name
    return root


def _fetch(data):
    calls = []

    def fetch(urls):
        calls.extend(urls)
        return [(u, data.get(u)) for u in urls]
    fetch.calls = calls
    return fetch


def _run(state, configs, lists, root, data, reports=None):
    rules = gp.load_provider_rules()
    fetch = _fetch(data)
    result = auto.run(state, reports or {}, {}, configs, lists, MANUAL, CATALOG, root, SECTIONS, rules, fetch, TODAY)
    return result, fetch.calls


def test_un_usuario_web_de_uruguay_activa_la_fuente_que_le_da_guia():
    root = _root(('Telefe.ar', 'Telefe', 'src-ar'))
    configs = {'c1': {'channels': {'AR| Telefe': {'epg': channel_alias('Telefe.ar')}}}}
    lists = {'c1': {'channels': [
        {'name': 'AR| Telefe', 'category': 'Argentina'},
        {'name': 'UY| Teledoce', 'category': 'Uruguay'},
        {'name': 'UY| Canal 10', 'category': 'Uruguay'},
    ]}}
    state = auto.empty_state()
    result, calls = _run(state, configs, lists, root, {'https://c/uy1.xml.gz': UY1, 'https://c/uy2.xml.gz': EMPTY})
    assert [(c['country'], c['missing']) for c in result['countries'] if c['missing']] == [('uy', 2)]
    assert 'https://c/uybig.xml.gz' not in calls, "demasiado pesada: ni se baja"
    assert 'https://c/tr.xml.gz' not in calls, "nadie tiene canales de Turquía"
    assert result['activated'] == ['cat-uy1']
    assert state['active']['cat-uy1']['firm'] == 2
    assert state['tried']['cat-uy2'] == {'at': TODAY, 'firm': 0, 'doubtful': 0}


def test_lo_manual_manda_y_lo_que_no_sumo_no_se_vuelve_a_bajar_enseguida():
    state = auto.empty_state()
    state['tried']['cat-uy2'] = {'at': '2026-10-05', 'firm': 0}
    countries = [{'country': 'uy', 'missing': 3, 'matched': 0}, {'country': 'ar', 'missing': 1, 'matched': 0}]
    picks = auto.pick_candidates(CATALOG, MANUAL['ids'], MANUAL['urls'], state, countries, TODAY)
    assert [p['id'] for p in picks] == ['cat-uy1'], "cat-ar es la manual (por URL); cat-uy2 se midió hace 4 días"
    state['tried']['cat-uy2']['at'] = '2026-09-30'
    picks = auto.pick_candidates(CATALOG, MANUAL['ids'], MANUAL['urls'], state, countries, TODAY)
    assert [p['id'] for p in picks] == ['cat-uy1', 'cat-uy2']


def test_ocultos_sin_guia_a_proposito_y_categorias_sin_guia_no_son_demanda():
    configs = {'c1': {'channels': {'UY| Oculto': {'hidden': True}, 'UY| Nada': {'manual': True, 'epg': None}},
                      'groups': {'hidden': ['Escondida'], 'noEpg': ['Radios']}}}
    lists = {'c1': {'channels': [
        {'name': 'UY| Oculto', 'category': 'Uruguay'},
        {'name': 'UY| Nada', 'category': 'Uruguay'},
        {'name': 'UY| X', 'category': 'Escondida'},
        {'name': 'UY| Radio', 'category': 'Radios'},
    ]}}
    result, calls = _run(auto.empty_state(), configs, lists, _root(), {})
    assert result['missing'] == 0 and calls == [] and result['activated'] == []


def test_presupuesto_y_rendimiento_por_mb():
    state = auto.empty_state()
    cands = [{'id': f'f{i}', 'size_bytes': 10**6} for i in range(6)] + [{'id': 'pesada', 'size_bytes': 20 * 10**6}]
    catalog = {c['id']: c for c in cands}
    gains = {f'f{i}': {'firm': 10 - i, 'doubtful': 0} for i in range(6)}
    gains['pesada'] = {'firm': 3, 'doubtful': 0}  # 3 canales por 20 MB: no vale lo que pesa
    activated, _ = auto.decide(state, catalog, cands, gains, {}, TODAY)
    assert activated == ['f0', 'f1', 'f2', 'f3'], "4 por corrida, las que más rinden primero"


def test_se_retira_tras_varias_corridas_sin_uso_ni_ganancia():
    state = auto.empty_state()
    state['active']['cat-tr'] = {'since': '2026-09-01', 'idle': auto.RETIRE_RUNS - 2}
    state['active']['cat-uy1'] = {'since': '2026-09-01', 'idle': 5}
    _, retired = auto.decide(state, CATALOG, [], {}, {'cat-uy1': 3}, TODAY)
    assert retired == [] and state['active']['cat-tr']['idle'] == auto.RETIRE_RUNS - 1
    assert state['active']['cat-uy1']['idle'] == 0 and state['active']['cat-uy1']['last_used'] == TODAY
    _, retired = auto.decide(state, CATALOG, [], {}, {}, TODAY)
    assert retired == ['cat-tr'] and 'cat-tr' in state['retired']
    assert 'cat-uy1' in state['active'], "la usada sigue aunque hoy no sume"


def test_una_activa_que_todavia_daria_guia_no_se_retira():
    """Alguien que no volvió a abrir Grilla sigue sin la guía en su configuración, pero la fuente
    automática ya activa se la daría: eso cuenta como ganancia, no se retira."""
    root = _root(('Teledoce.uy', 'Teledoce', 'cat-uy1'))
    state = auto.empty_state()
    state['active']['cat-uy1'] = {'since': '2026-10-01', 'idle': auto.RETIRE_RUNS - 1}
    lists = {'c1': {'channels': [{'name': 'UY| Teledoce', 'category': 'Uruguay'}]}}
    result, _ = _run(state, {'c1': {'channels': {}}}, lists, root, {'https://c/uy2.xml.gz': EMPTY})
    assert result['retired'] == [] and state['active']['cat-uy1']['potential'] == 1


def test_uso_de_las_configuraciones_web_por_alias():
    root = _root(('Teledoce.uy', 'Teledoce', 'cat-uy1'))
    state = auto.empty_state()
    state['active']['cat-uy1'] = {'since': '2026-10-01', 'idle': auto.RETIRE_RUNS - 1}
    configs = {'c1': {'channels': {'Teledoce': {'epg': channel_alias('Teledoce.uy')}}}}
    result, calls = _run(state, configs, {}, root, {})
    assert calls == [] and result['retired'] == [] and state['active']['cat-uy1']['used'] == 1


def test_merge_suma_las_automaticas_detras_de_las_manuales(tmp_path):
    urls = tmp_path / 'epg_urls.json'
    urls.write_text(json.dumps({'sources': [
        {'id': 'm1', 'url': 'https://x/m1.xml.gz'},
        {'id': 'm2', 'url': 'https://x/m2.xml.gz', 'active': False},
    ]}))
    catalog = tmp_path / 'catalog.json'
    catalog.write_text(json.dumps({'sources': [
        {'id': 'a1', 'url': 'https://c/a1.xml.gz', 'country': 'uy'},
        {'id': 'm2', 'url': 'https://x/m2.xml.gz'},
        {'id': 'a2', 'url': 'https://x/m1.xml.gz'},
    ]}))
    state = tmp_path / 'auto.json'
    state.write_text(json.dumps({'active': {'a1': {}, 'm2': {}, 'a2': {}, 'gone': {}}}))
    sources = merge_epgs.load_sources(str(urls), str(catalog), str(state))
    assert [(s['id'], s['priority']) for s in sources] == [('m1', 0), ('a1', merge_epgs.AUTO_PRIORITY)], (
        "m2 está desactivada a mano, a2 es la URL de una manual y gone no está en el catálogo")
    assert sources[1]['country'] == 'uy'
    assert merge_epgs.load_sources(str(urls), str(catalog), str(tmp_path / 'no.json')) == sources[:1]


def test_estado_ilegible_arranca_vacio():
    assert auto.parse_state(b'{roto') == auto.empty_state()
    assert auto.parse_state(None) == auto.empty_state()
