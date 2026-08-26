"""Tests del merge: procedencia de fuentes y deduplicación de programas.

Sin red: se parchea download_epg para devolver XML sintéticos.
"""
import gzip
import json
import os
import sys

import pytest
from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import merge_epgs


def _epg(channels, programmes):
    """Arma un XMLTV mínimo. channels: [(id, nombre)]. programmes: [(channel, start, stop, titulo)]."""
    parts = ['<?xml version="1.0" encoding="UTF-8" ?>', '<tv>']
    for cid, name in channels:
        parts.append(f'<channel id="{cid}"><display-name>{name}</display-name></channel>')
    for chan, start, stop, title in programmes:
        parts.append(
            f'<programme channel="{chan}" start="{start}" stop="{stop}">'
            f'<title>{title}</title></programme>'
        )
    parts.append('</tv>')
    return '\n'.join(parts).encode('utf-8')


@pytest.fixture
def run_merge(tmp_path, monkeypatch):
    """Corre merge_epgs() sobre fuentes sintéticas y devuelve el árbol resultante."""
    def _run(sources_config, payloads):
        monkeypatch.chdir(tmp_path)
        (tmp_path / 'epg_urls.json').write_text(json.dumps(sources_config), encoding='utf-8')
        monkeypatch.setattr(
            merge_epgs, 'download_all',
            lambda urls, **kw: [(u, payloads.get(u)) for u in urls],
        )
        merge_epgs.merge_epgs()
        with gzip.open(tmp_path / 'merged.xml.gz', 'rb') as f:
            return etree.fromstring(f.read())
    return _run


def test_programas_no_se_duplican_entre_fuentes_solapadas(run_merge):
    """El bug original: un canal presente en 2 fuentes acumulaba la programación de ambas."""
    root = run_merge(
        {'sources': [
            {'id': 'buena', 'url': 'http://a'},
            {'id': 'otra', 'url': 'http://b'},
        ]},
        {
            'http://a': _epg([('Neox.es', 'Neox')],
                             [('Neox.es', '20240101100000 +0000', '20240101110000 +0000', 'De A')]),
            'http://b': _epg([('Neox.es', 'Neox')],
                             [('Neox.es', '20240101100000 +0000', '20240101113000 +0000', 'De B')]),
        },
    )
    progs = root.findall('programme')
    assert len(progs) == 1, "el mismo horario del mismo canal no debe aparecer dos veces"
    assert progs[0].find('title').text == 'De A', "ante colisión gana la fuente más prioritaria"


def test_fuente_menos_prioritaria_extiende_la_cobertura(run_merge):
    """Deduplicar no debe perder días de guía que la fuente ganadora no cubre."""
    root = run_merge(
        {'sources': [
            {'id': 'corta', 'url': 'http://a'},
            {'id': 'larga', 'url': 'http://b'},
        ]},
        {
            'http://a': _epg([('X.es', 'X')],
                             [('X.es', '20240101100000 +0000', '20240101110000 +0000', 'Dia 1')]),
            'http://b': _epg([('X.es', 'X')], [
                ('X.es', '20240101100000 +0000', '20240101110000 +0000', 'Dia 1 bis'),
                ('X.es', '20240102100000 +0000', '20240102110000 +0000', 'Dia 2'),
            ]),
        },
    )
    titulos = [p.find('title').text for p in root.findall('programme')]
    assert titulos == ['Dia 1', 'Dia 2']


def test_canal_lleva_el_id_de_su_fuente(run_merge):
    root = run_merge(
        {'sources': [
            {'id': 'acidjesuz-us', 'url': 'http://a'},
            {'id': 'openepg-us1', 'url': 'http://b'},
        ]},
        {
            'http://a': _epg([('TBS.us', 'TBS')],
                             [('TBS.us', '20240101100000 +0000', '20240101110000 +0000', 'T')]),
            'http://b': _epg([('Otro.us', 'Otro')],
                             [('Otro.us', '20240101100000 +0000', '20240101110000 +0000', 'O')]),
        },
    )
    fuentes = {c.get('id'): c.get('source') for c in root.findall('channel')}
    assert fuentes == {'TBS.us': 'acidjesuz-us', 'Otro.us': 'openepg-us1'}


def test_priority_explicita_gana_sobre_el_orden_del_archivo(run_merge):
    root = run_merge(
        {'sources': [
            {'id': 'primera', 'url': 'http://a'},
            {'id': 'preferida', 'url': 'http://b', 'priority': -1},
        ]},
        {
            'http://a': _epg([('X.es', 'X')],
                             [('X.es', '20240101100000 +0000', '20240101110000 +0000', 'A')]),
            'http://b': _epg([('X.es', 'X')],
                             [('X.es', '20240101100000 +0000', '20240101110000 +0000', 'B')]),
        },
    )
    assert root.find('channel').get('source') == 'preferida'
    assert root.find('programme').find('title').text == 'B'


def test_canal_sin_programas_se_descarta(run_merge):
    root = run_merge(
        {'sources': [{'id': 'a', 'url': 'http://a'}]},
        {'http://a': _epg([('Vacio.es', 'Vacio'), ('Lleno.es', 'Lleno')],
                          [('Lleno.es', '20240101100000 +0000', '20240101110000 +0000', 'L')])},
    )
    assert [c.get('id') for c in root.findall('channel')] == ['Lleno.es']


def test_formato_viejo_de_lista_de_strings_sigue_funcionando(run_merge):
    """epg_urls.json con 'urls': [...] debe seguir cargando, con la posición como prioridad."""
    root = run_merge(
        {'urls': ['http://a', '# http://deshabilitada', 'http://b']},
        {
            'http://a': _epg([('X.es', 'X')],
                             [('X.es', '20240101100000 +0000', '20240101110000 +0000', 'A')]),
            'http://b': _epg([('X.es', 'X')],
                             [('X.es', '20240101100000 +0000', '20240101110000 +0000', 'B')]),
        },
    )
    assert root.find('programme').find('title').text == 'A'
    assert root.find('channel').get('source') == 'a', "el id se deriva del nombre de archivo"


def test_metadata_de_una_fuente_programas_de_otra(run_merge):
    """Si la fuente prioritaria declara el canal pero no trae programas, se conserva su
    metadata y los programas los aporta la siguiente que sí los tenga."""
    root = run_merge(
        {'sources': [
            {'id': 'solo-metadata', 'url': 'http://a'},
            {'id': 'con-datos', 'url': 'http://b'},
        ]},
        {
            'http://a': _epg([('X.es', 'Nombre Bueno')], []),
            'http://b': _epg([('X.es', 'Nombre Malo')],
                             [('X.es', '20240101100000 +0000', '20240101110000 +0000', 'P')]),
        },
    )
    canal = root.find('channel')
    assert canal.find('display-name').text == 'Nombre Bueno'
    assert canal.get('source') == 'solo-metadata'
    assert len(root.findall('programme')) == 1
