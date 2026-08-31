"""Tests del parseo de nombres y del puntaje de coincidencia. Funciones puras, sin red."""
import os
import sys

import pytest
from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from channel_names import detect_country, flag_to_country_code, parse_channel_name, strip_display_prefix
from epg_index import EpgIndex, pick_display_name


# --------------------------------------------------------------------------- parseo

def test_sufijo_de_idioma_es_senal_no_basura():
    """"-EN" es la etiqueta que el proveedor le pone a sus canales en inglés: indica que hay
    que buscar el canal en fuentes de EE.UU./UK/Canadá, no es ruido a descartar."""
    p = parse_channel_name('TBS -EN')
    assert p.core == ('tbs',)
    assert p.language == 'en'


def test_pais_de_varias_palabras_se_detecta():
    """Regresión: el patrón se armaba con la clave 'costarica' pegada, así que "Costa Rica"
    con espacio nunca matcheaba y ningún canal de Costa Rica detectaba su país."""
    p = parse_channel_name('Warner TV Costa Rica')
    assert p.country == 'cr'
    assert p.core == ('warner', 'tv')


@pytest.mark.parametrize('nombre,esperado', [
    ('Estados Unidos', 'us'),
    ('Puerto Rico', 'pr'),
    ('Republica Dominicana', 'do'),
    ('El Salvador', 'sv'),
    ('Reino Unido', 'uk'),
])
def test_paises_de_varias_palabras(nombre, esperado):
    assert detect_country(nombre) == esperado


def test_television_no_se_borra():
    """Se matchea por solapamiento, así que no hace falta mutilar el nombre."""
    assert parse_channel_name('E! Entertainment Television').core == ('e', 'entertainment', 'television')


def test_tv_es_un_token_mas():
    """Ya no existe el caso especial de "no borrar TV si no está al final"."""
    assert parse_channel_name('TV Land').core == ('tv', 'land')


def test_pais_suelto_sale_del_nucleo():
    p = parse_channel_name('ESPN 1 ARG')
    assert p.country == 'ar'
    assert p.core == ('espn', '1')


def test_prefijo_de_pais_del_proveedor():
    p = parse_channel_name('PE | Latina')
    assert p.country == 'pe'
    assert p.core == ('latina',)


@pytest.mark.parametrize('nombre,limpio,pais', [
    ('UY| Canal 10', 'Canal 10', 'uy'),
    ('PT| RTP 1', 'RTP 1', 'pt'),
    ('ES: La 1', 'La 1', 'es'),
    ('CL|TVN', 'TVN', 'cl'),
    ('BR| Globo', 'Globo', 'br'),
    ('AR| Telefe', 'Telefe', 'ar'),
    ('USA| CBS', 'CBS', 'us'),
    ('E| Entertainment', 'Entertainment', None),
    ('S| Somos', 'Somos', None),
    ('D| Discovery', 'Discovery', None),
    ('EVENTS 01: Box Estelar', 'Box Estelar', None),
    ('EVENTS 12:UFC 300', 'UFC 300', None),
    ('24P Suspenso', 'Suspenso', None),
    ('24H Cinema', 'Cinema', None),
])
def test_prefijo_visible_se_saca_del_nombre(nombre, limpio, pais):
    clean, country = strip_display_prefix(nombre)
    assert clean == limpio
    assert country == pais


def test_prefijo_visible_no_toca_nombres_sin_prefijo():
    assert strip_display_prefix('ESPN') == ('ESPN', None)
    assert strip_display_prefix('USA Network') == ('USA Network', None), \
        "sin separador '|' o ':' no es el prefijo, es el nombre real del canal"
    assert strip_display_prefix('') == ('', None)


def test_calidad_y_region_son_senales_aparte():
    p = parse_channel_name('TBS East HD')
    assert p.core == ('tbs',)
    assert p.region == 'east'
    assert p.quality == ('hd',)


def test_en_dentro_del_nombre_no_es_idioma():
    """"en" solo cuenta como sufijo de idioma al final; en medio es una palabra española."""
    p = parse_channel_name('Cine en Casa')
    assert p.language is None
    assert 'en' in p.core


def test_bandera_a_codigo_de_pais():
    assert flag_to_country_code('🇦🇷 DEPORTES') == 'ar'
    assert flag_to_country_code('🇬🇧 UK') == 'uk', "el emoji dice 'gb' pero los channel_id usan 'uk'"
    assert flag_to_country_code('ESPN') is None


def test_pick_display_name_descarta_variantes_con_numero_de_canal():
    assert pick_display_name(['Laff', '247 Laff', '247']) == 'Laff'


# --------------------------------------------------------------------------- puntaje

def _index(channels, sources=None):
    """channels: [(id, [display_names], source_id)]"""
    parts = ['<tv>']
    for cid, names, source in channels:
        attr = f' source="{source}"' if source else ''
        inner = ''.join(f'<display-name>{n}</display-name>' for n in names)
        parts.append(f'<channel id="{cid}"{attr}>{inner}</channel>')
    parts.append('</tv>')
    return EpgIndex(etree.fromstring('\n'.join(parts)), sources=sources)


def _best(idx, nombre, **kw):
    ranked = idx.rank(parse_channel_name(nombre), **kw)
    return ranked[0].channel_id if ranked else None


def test_matchea_sin_borrar_television():
    idx = _index([('E.us', ['E! Entertainment'], None), ('Otro.us', ['Discovery'], None)])
    assert _best(idx, 'E! Entertainment Television') == 'E.us'


def test_nombre_exacto_gana_sobre_el_que_agrega_tokens():
    """Para "Laff", el canal "Laff" gana sobre la afiliada local, que también lo cubre entero
    pero arrastra tokens ajenos."""
    idx = _index([
        ('LaffLocal.us', ['Laff (WUOA) Birmingham, AL'], None),
        ('Laff.us', ['Laff'], None),
    ])
    ranked = idx.rank(parse_channel_name('Laff'))
    assert [c.channel_id for c in ranked] == ['Laff.us', 'LaffLocal.us']


def test_afiliada_local_igual_matchea():
    idx = _index([('LaffLocal.us', ['Laff (WUOA) Birmingham, AL HD'], None)])
    assert _best(idx, 'Laff') == 'LaffLocal.us'


def test_warner_tv_gana_sobre_warner_channel():
    idx = _index([('WarnerChannel.cr', ['Warner Channel'], None), ('WarnerTV.cr', ['Warner TV'], None)])
    ranked = idx.rank(parse_channel_name('Warner TV Costa Rica'))
    assert ranked[0].channel_id == 'WarnerTV.cr'
    assert ranked[0].score > ranked[1].score


def test_cobertura_parcial_con_numero():
    """"ESPN 1 ARG" matchea "ESPN" sin necesidad del hack de reintentar sin el " 1" final."""
    idx = _index([('ESPN.ar', ['ESPN'], None), ('Otro.ar', ['TyC Sports'], None)])
    assert _best(idx, 'ESPN 1 ARG') == 'ESPN.ar'


def test_el_pais_desempata_entre_homonimos():
    idx = _index([('Canal26.cl', ['Canal 26'], None), ('Canal26.ar', ['Canal 26'], None)])
    assert _best(idx, 'Canal 26', country='ar') == 'Canal26.ar'


def test_pais_distinto_penaliza_por_debajo_del_umbral():
    from epg_index import MIN_SCORE
    idx = _index([('Canal26.cl', ['Canal 26'], None)])
    ranked = idx.rank(parse_channel_name('Canal 26'), country='ar')
    assert ranked[0].score < MIN_SCORE, "un canal de otro país no debe aceptarse automáticamente"


def test_idioma_ingles_sesga_hacia_fuentes_de_ee_uu():
    """"TBS -EN" no dice el país, pero el sufijo de idioma sí: debe ganar el feed de EE.UU."""
    idx = _index(
        [('TBS.mx', ['TBS'], 'openepg-mexico1'), ('TBS.us', ['TBS'], 'acidjesuz-us')],
        sources={'openepg-mexico1': {'country': 'mx'}, 'acidjesuz-us': {'country': 'us'}},
    )
    assert _best(idx, 'TBS -EN') == 'TBS.us'


def test_fuente_preferida_por_la_seccion_gana():
    idx = _index(
        [('TBS.a', ['TBS'], 'openepg-us1'), ('TBS.b', ['TBS'], 'acidjesuz-us')],
        sources={'openepg-us1': {'country': 'us'}, 'acidjesuz-us': {'country': 'us'}},
    )
    assert _best(idx, 'TBS', prefer_sources=['acidjesuz-us']) == 'TBS.b'


def test_region_desempata_feeds_de_ee_uu():
    idx = _index([('TBSP.us', ['TBS Pacific'], None), ('TBSE.us', ['TBS East'], None)])
    assert _best(idx, 'TBS East') == 'TBSE.us'


def test_compartir_tokens_genericos_no_alcanza_para_matchear():
    """"tv" y "channel" aparecen en todos lados: su IDF es bajo, así que compartirlos no debe
    levantar a un candidato que no comparte el token que de verdad identifica al canal.
    Esto es lo que reemplaza a la lista manual de sufijos a ignorar."""
    from epg_index import MIN_SCORE
    idx = _index([(f'C{i}.us', [f'Cosa {i} TV Channel'], None) for i in range(40)]
                 + [('Real.us', ['Warner'], None)])
    ranked = idx.rank(parse_channel_name('Warner TV Channel'))
    assert ranked[0].channel_id == 'Real.us'
    genericos = [c for c in ranked if c.channel_id != 'Real.us']
    assert genericos, "los canales genéricos igual entran como candidatos..."
    assert all(c.score < MIN_SCORE for c in genericos), "...pero no llegan al umbral de match"
    assert ranked[0].score > 2 * max(c.score for c in genericos)


def test_sin_solapamiento_no_hay_candidatos():
    idx = _index([('A.us', ['Discovery'], None)])
    assert idx.rank(parse_channel_name('Telemundo')) == []


def test_pais_de_la_fuente_cuando_el_id_no_lo_dice():
    idx = _index([('613', ['Canal 613'], 'openepg-bolivia1')],
                 sources={'openepg-bolivia1': {'country': 'bo'}})
    assert idx.country['613'] == 'bo'
