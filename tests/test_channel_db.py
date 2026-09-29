"""Diccionario de canales de iptv-org (channel_db.py) y su uso como último recurso."""
import os
import sys

from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generate_playlist  # noqa: E402
from channel_db import ChannelDb  # noqa: E402
from epg_index import EpgIndex  # noqa: E402

DB = ChannelDb([
    {'id': 'LaNacionPlus.ar', 'name': 'LN+', 'alt_names': ['La Nación +'], 'country': 'AR', 'closed': None},
    {'id': 'Canal13Cable.cl', 'name': '13C', 'alt_names': ['Canal 13 Cable'], 'country': 'CL', 'closed': None},
    {'id': 'RTL1025Traffic.it', 'name': 'RTL 102.5 Traffic', 'alt_names': ['RTL 102.5'], 'country': 'IT', 'closed': None},
    {'id': 'FoxSports1.us', 'name': 'FOX Sports 1', 'alt_names': ['FS1'], 'country': 'US', 'closed': None},
    {'id': 'Viejo.ar', 'name': 'Canal Viejo', 'alt_names': ['Otro'], 'country': 'AR', 'closed': '2020-01-01'},
])


def _idx(*channels):
    xml = '<tv>' + ''.join(f'<channel id="{cid}"><display-name>{n}</display-name></channel>'
                           for cid, n in channels) + '</tv>'
    return EpgIndex(etree.fromstring(xml))


def test_alias_por_nombre_y_por_id():
    assert ('La Nación +', 'ar') in DB.aliases('LN+')
    assert ('Canal 13 Cable', 'cl') in DB.aliases('cualquiera', tvg_id='Canal13Cable.cl@SD')
    assert DB.aliases('Canal Viejo') == [], "los canales cerrados no cuentan"


def test_un_recorte_del_nombre_no_es_alias():
    """"RTL 102.5" no es otro nombre de "RTL 102.5 Traffic": es otro canal."""
    assert DB.aliases('RTL 102.5 Traffic') == []


def test_se_usa_solo_si_el_nombre_no_encontro_nada():
    idx = _idx(('Canal13Cable.cl', 'Canal 13 Cable'), ('Otro.cl', 'Canal cualquiera'))
    _, sin_dic, _, _, _ = generate_playlist.match_stream('13C (1080p)', None, idx, {}, {}, 'cl')
    try:
        generate_playlist.set_channel_db(DB)
        _, cid, reason, score, _ = generate_playlist.match_stream('13C (1080p)', None, idx, {}, {}, 'cl')
    finally:
        generate_playlist.set_channel_db(None)
    assert sin_dic is None
    assert (cid, reason) == ('Canal13Cable.cl', 'alias')
    assert score >= 0.8


def test_alias_de_otro_pais_no_se_acepta():
    """"FOX Sports 1 CL" no es el de EE.UU. aunque el diccionario conozca "FS1"."""
    idx = _idx(('FS1.us', 'FS1'))
    try:
        generate_playlist.set_channel_db(DB)
        _, cid, _, _, _ = generate_playlist.match_stream('FOX Sports 1 CL', None, idx, {}, {}, None)
    finally:
        generate_playlist.set_channel_db(None)
    assert cid is None
