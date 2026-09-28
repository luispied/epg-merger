"""Tests de tools/source_coverage.py (sin red: la candidata se entrega ya bajada)."""
import datetime
import os
import sys

from lxml import etree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import generate_playlist as gp  # noqa: E402
import source_coverage as sc  # noqa: E402

NOW = datetime.datetime(2026, 9, 28, 12, 0, tzinfo=datetime.timezone.utc)
SECTIONS = ([], [], {}, {})


def _root(*channels):
    root = etree.Element('tv')
    for cid, name, source in channels:
        ch = etree.SubElement(root, 'channel', id=cid, source=source)
        etree.SubElement(ch, 'display-name').text = name
    return root


def _ch(name, category, chosen=None, alternatives=(), reason=None, section=None):
    return {'xtream_name': name, 'category': category, 'section': section, 'chosen': chosen,
            'reason': reason or ('name' if chosen else None), 'score': 1.0 if chosen else 0.0,
            'alternatives': [{'channel_id': a, 'score': 0.5, 'source': None} for a in alternatives]}


USER_SOURCES = [
    {'id': 'src-ar', 'url': 'https://x/ar.xml.gz', 'country': 'ar', 'active': True},
    {'id': 'src-es', 'url': 'https://x/es.xml.gz', 'country': 'es', 'active': True},
    {'id': 'src-old', 'url': 'https://x/old.xml.gz', 'country': 'it', 'active': False,
     'inactive_reason': 'sin uso'},
]

CATALOG = {
    'cat-cl1': {'id': 'cat-cl1', 'url': 'https://c/cl1.xml.gz', 'country': 'cl', 'provider': 'c',
                'status': 'fresh', 'live_channels': 50},
    'cat-cl2': {'id': 'cat-cl2', 'url': 'https://c/cl2.xml.gz', 'country': 'cl', 'provider': 'c',
                'status': 'fresh', 'live_channels': 10},
    'cat-uy1': {'id': 'cat-uy1', 'url': 'https://c/uy1.xml.gz', 'country': 'uy', 'provider': 'c',
                'status': 'fresh', 'live_channels': 5},
    'cat-cl-stale': {'id': 'cat-cl-stale', 'url': 'https://c/cls.xml.gz', 'country': 'cl',
                     'provider': 'c', 'status': 'stale'},
    'cat-fr': {'id': 'cat-fr', 'url': 'https://c/fr.xml.gz', 'country': 'fr', 'provider': 'c',
               'status': 'fresh', 'live_channels': 99},
    # Ya elegida por el usuario (misma URL, otro id): no se sugiere.
    'cat-ar': {'id': 'cat-ar', 'url': 'https://x/ar.xml.gz', 'country': 'ar', 'provider': 'x',
               'status': 'fresh'},
}


def test_uso_por_fuente_y_sin_uso():
    root = _root(('Telefe.ar', 'Telefe', 'src-ar'), ('TVE.es', 'La 1', 'src-es'))
    reports = {'luis': [
        _ch('AR| Telefe', 'Argentina', 'Telefe.ar'),
        _ch('Oculto', 'España', 'TVE.es'),
    ]}
    channel_map = {'hidden': {'Oculto': True}}
    report = sc.run(reports, channel_map, USER_SOURCES, CATALOG, root, SECTIONS, gp.load_provider_rules(),
                    fetch=False, now=NOW)
    by_id = {s['id']: s for s in report['sources']}
    assert by_id['src-ar']['used_by'] == 1
    assert by_id['src-es']['used_by'] == 0, "el único canal que la usa está oculto"
    assert report['unused_active'] == ['src-es'], "la inactiva no cuenta como 'sin uso'"
    assert by_id['src-old']['active'] is False and by_id['src-old']['inactive_reason'] == 'sin uso'
    assert by_id['src-ar']['provider'] == 'x', "sale del catálogo, buscado por URL"
    assert report['summary']['active'] == 2 and report['summary']['inactive'] == 1


def test_mismo_canal_en_dos_perfiles_cuenta_una_vez_y_alternativas():
    root = _root(('Telefe.ar', 'Telefe', 'src-ar'), ('TVE.es', 'La 1', 'src-es'))
    ch = _ch('AR| Telefe', 'Argentina', 'Telefe.ar', alternatives=['TVE.es'])
    report = sc.run({'a': [ch], 'b': [dict(ch)]}, {}, USER_SOURCES, CATALOG, root, SECTIONS,
                    gp.load_provider_rules(), fetch=False, now=NOW)
    by_id = {s['id']: s for s in report['sources']}
    assert by_id['src-ar']['used_by'] == 1 and by_id['src-es']['alt_by'] == 1


def test_paises_detectados_y_candidatas_por_turnos():
    reports = {'luis': [
        _ch('CL| Mega', 'Chile'),                 # prefijo del nombre
        _ch('Chilevision', '🇨🇱 Chile'),           # bandera de la categoría
        _ch('Canal 10', '🇺🇾 Uruguay'),
        _ch('Algo', 'General'),                   # sin guía a propósito (provider_rules no_epg)
        _ch('Forzado', '🇫🇷 Francia', reason='override_none'),
        _ch('Separador', '▆▆▆ＤＥＰＯＲＴＥＳ▆▆▆'),
    ]}
    report = sc.run(reports, {}, USER_SOURCES, CATALOG, _root(), SECTIONS, gp.load_provider_rules(),
                    fetch=False, now=NOW)
    assert report['summary']['missing_channels'] == 3
    assert [(c['country'], c['missing']) for c in report['countries']] == [('cl', 2), ('uy', 1)]
    # Chile primero (más faltantes), después Uruguay, después el segundo de Chile. Ni la stale
    # ni la de Francia (no le falta nada) ni la que ya tiene por URL.
    assert [s['id'] for s in report['suggestions']] == ['cat-cl1', 'cat-uy1', 'cat-cl2']
    assert all(not s['measured'] for s in report['suggestions'])


def test_categoria_sin_guia_desde_la_interfaz_no_cuenta_como_faltante():
    reports = {'luis': [_ch('CL| Mega', 'Chile')]}
    report = sc.run(reports, {'no_epg_categories': {'Chile': True}}, USER_SOURCES, CATALOG, _root(),
                    SECTIONS, gp.load_provider_rules(), fetch=False, now=NOW)
    assert report['summary']['missing_channels'] == 0 and report['suggestions'] == []


def test_sugerencia_medida_con_el_matcher_real():
    root = _root(('Telefe.ar', 'Telefe', 'src-ar'))
    reports = {'luis': [
        _ch('AR| Telefe', 'Argentina', 'Telefe.ar'),
        _ch('CL| Mega', 'Chile'),
        _ch('CL| Chilevision HD', 'Chile'),
    ]}
    candidate = b'''<?xml version="1.0"?><tv>
<channel id="Mega.cl"><display-name>Mega</display-name></channel>
<channel id="CHV.cl"><display-name>Chilevision</display-name></channel>
<channel id="Viejo.cl"><display-name>Canal Viejo</display-name></channel>
<programme channel="Mega.cl" start="20260928110000 +0000" stop="20260928130000 +0000"><title>x</title></programme>
<programme channel="CHV.cl" start="20260928110000 +0000" stop="20260928130000 +0000"><title>x</title></programme>
<programme channel="Viejo.cl" start="20250101000000 +0000" stop="20250101010000 +0000"><title>x</title></programme>
</tv>'''
    fetched = []

    def fetch(urls):
        fetched.extend(urls)
        return [(u, candidate if u == 'https://c/cl1.xml.gz' else None) for u in urls]

    report = sc.run(reports, {}, USER_SOURCES, CATALOG, root, SECTIONS, gp.load_provider_rules(),
                    fetch=fetch, now=NOW)
    assert set(fetched) == {'https://c/cl1.xml.gz', 'https://c/cl2.xml.gz'}
    assert len(root) == 1, "no toca la guía original"
    sugs = {s['id']: s for s in report['suggestions']}
    assert list(sugs) == ['cat-cl1'], "cl2 no se pudo bajar: no se sugiere"
    s = sugs['cat-cl1']
    assert s['measured'] and s['new_channels'] == 2, "el canal sin programación vigente no suma"
    assert s['firm'] == 2 and s['doubtful'] == 0
    assert {e['channel'] for e in s['examples']} == {'CL| Mega', 'CL| Chilevision HD'}
