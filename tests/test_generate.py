"""Test end-to-end de generate_playlist con un Xtream falso: dos perfiles, sin red."""
import gzip
import json
import os
import sys

import pytest
from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generate_playlist


MERGED = """<tv>
  <channel id="TBS.us" source="acidjesuz-us">
    <display-name>TBS</display-name><icon src="http://logo/tbs.png"/>
  </channel>
  <channel id="TBS.mx" source="openepg-mexico1">
    <display-name>TBS</display-name>
  </channel>
  <channel id="Warner.cr" source="openepg-costarica1">
    <display-name>Warner TV</display-name>
  </channel>
  <programme channel="TBS.us" start="20240101100000 +0000" stop="20240101110000 +0000"><title>A</title></programme>
  <programme channel="TBS.mx" start="20240101100000 +0000" stop="20240101110000 +0000"><title>B</title></programme>
  <programme channel="Warner.cr" start="20240101100000 +0000" stop="20240101110000 +0000"><title>C</title></programme>
</tv>"""

SOURCES = {'sources': [
    {'id': 'acidjesuz-us', 'url': 'http://us', 'country': 'us'},
    {'id': 'openepg-mexico1', 'url': 'http://mx', 'country': 'mx'},
    {'id': 'openepg-costarica1', 'url': 'http://cr', 'country': 'cr'},
]}

SECTIONS = {
    'order': ['ENGLISH', 'PAÍSES'],
    'rules': [
        {'section': 'ENGLISH', 'starts_with': ['usa'],
         'epg': {'country': 'us', 'prefer_sources': ['acidjesuz-us']}},
        {'section': 'PAÍSES', 'country_flag': True},
    ],
}

STREAMS = [
    {'stream_id': 1, 'name': 'TBS -EN', 'category_id': '1', 'container_extension': 'ts'},
    {'stream_id': 2, 'name': 'Warner TV Costa Rica', 'category_id': '2'},
    {'stream_id': 3, 'name': 'Canal Inexistente', 'category_id': '2'},
]
CATEGORIES = {'1': 'USA ENTERTAINMENT', '2': '🇨🇷 COSTA RICA'}


@pytest.fixture
def proyecto(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(SECTIONS), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], STREAMS))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: CATEGORIES)
    return tmp_path


def _correr(monkeypatch, perfiles):
    monkeypatch.setenv('XTREAM_PROFILES', json.dumps(perfiles))
    generate_playlist.generate()


def _playlist(tmp_path, perfil):
    return (tmp_path / 'out' / perfil / 'playlist.m3u8').read_text(encoding='utf-8')


def _reporte(tmp_path, perfil):
    with open(tmp_path / 'out' / perfil / 'match_report.json', encoding='utf-8') as f:
        return json.load(f)


PERFILES = [
    {'name': 'luis', 'servers': ['http://s1:8080'], 'username': 'u1', 'password': 'clave-de-luis'},
    {'name': 'juan', 'servers': ['http://s1:8080'], 'username': 'u2', 'password': 'clave-de-juan'},
]


def test_cada_perfil_tiene_sus_propias_credenciales(proyecto, monkeypatch):
    _correr(monkeypatch, PERFILES)
    assert 'clave-de-luis' in _playlist(proyecto, 'luis')
    assert 'clave-de-luis' not in _playlist(proyecto, 'juan')
    assert 'clave-de-juan' in _playlist(proyecto, 'juan')


def test_los_perfiles_no_se_pisan_entre_si(proyecto, monkeypatch):
    """El árbol del EPG se reutiliza entre perfiles: si se apendaran los elementos en vez de
    copiarlos, el segundo perfil se quedaría sin canales."""
    _correr(monkeypatch, PERFILES)
    contenido = {}
    for perfil in ('luis', 'juan'):
        with gzip.open(proyecto / 'out' / perfil / 'epg.xml.gz', 'rb') as f:
            root = etree.fromstring(f.read())
        canales = sorted(c.get('id') for c in root.findall('channel'))
        assert canales, f"{perfil} se quedó sin canales"
        contenido[perfil] = (canales, len(root.findall('programme')))

    # TBS.us (elegido) + TBS.mx (alternativa) + Warner.cr, con su programa cada uno.
    assert contenido['luis'] == (['TBS.mx', 'TBS.us', 'Warner.cr'], 3)
    assert contenido['juan'] == contenido['luis'], "los perfiles deben recibir la misma guía"


def test_el_sufijo_de_idioma_elige_el_feed_de_ee_uu(proyecto, monkeypatch):
    """"TBS -EN" en la sección ENGLISH debe caer en TBS.us, no en el feed mexicano."""
    _correr(monkeypatch, PERFILES[:1])
    canales = {c['xtream_name']: c for c in _reporte(proyecto, 'luis')['channels']}
    assert canales['TBS -EN']['chosen'] == 'TBS.us'
    assert canales['TBS -EN']['reason'] == 'prefer_source'


def test_pais_dentro_del_nombre_encuentra_su_canal(proyecto, monkeypatch):
    _correr(monkeypatch, PERFILES[:1])
    canales = {c['xtream_name']: c for c in _reporte(proyecto, 'luis')['channels']}
    assert canales['Warner TV Costa Rica']['chosen'] == 'Warner.cr'


def test_canal_sin_match_queda_con_su_nombre_como_tvg_id(proyecto, monkeypatch):
    _correr(monkeypatch, PERFILES[:1])
    canales = {c['xtream_name']: c for c in _reporte(proyecto, 'luis')['channels']}
    assert canales['Canal Inexistente']['chosen'] is None
    assert 'tvg-id="Canal Inexistente"' in _playlist(proyecto, 'luis')


def test_el_reporte_no_lleva_credenciales(proyecto, monkeypatch):
    """El reporte se guarda como artifact para diffear entre corridas: no puede llevar
    las URLs de stream, que sí tienen usuario y contraseña adentro."""
    _correr(monkeypatch, PERFILES)
    for perfil, clave in (('luis', 'clave-de-luis'), ('juan', 'clave-de-juan')):
        crudo = (proyecto / 'out' / perfil / 'match_report.json').read_text(encoding='utf-8')
        assert clave not in crudo
        with gzip.open(proyecto / 'out' / perfil / 'epg.xml.gz', 'rb') as f:
            assert clave.encode() not in f.read()


def test_las_secciones_ordenan_la_playlist(proyecto, monkeypatch):
    _correr(monkeypatch, PERFILES[:1])
    lineas = [l for l in _playlist(proyecto, 'luis').splitlines() if l.startswith('#EXTINF')]
    grupos = [l.split('group-title="')[1].split('"')[0] for l in lineas]
    assert grupos[0] == 'USA ENTERTAINMENT', "ENGLISH va antes que PAÍSES según 'order'"


def test_las_categorias_se_ordenan_alfabeticamente_dentro_de_la_seccion(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(SECTIONS), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [
        {'stream_id': 1, 'name': 'Canal Z', 'category_id': 'z'},
        {'stream_id': 2, 'name': 'Canal A', 'category_id': 'a'},
        {'stream_id': 3, 'name': 'Canal M', 'category_id': 'm'},
    ]
    # A propósito en un orden distinto al alfabético, para probar que no se respeta el orden
    # en que el proveedor las devuelve sino el alfabético de sus nombres.
    categories = {'z': 'USA Zeta', 'a': 'USA Alfa', 'm': 'USA Eme'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    lineas = [l for l in _playlist(tmp_path, 'luis').splitlines() if l.startswith('#EXTINF')]
    grupos = [l.split('group-title="')[1].split('"')[0] for l in lineas]
    assert grupos == ['USA Alfa', 'USA Eme', 'USA Zeta']


def test_category_order_respeta_el_orden_explicito_y_agrega_nuevas_al_final(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    sections = {
        'order': ['ENGLISH'],
        'rules': [{'section': 'ENGLISH', 'starts_with': ['usa'],
                   'category_order': ['USA Zeta', 'USA Alfa']}],
    }
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(sections), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [
        {'stream_id': 1, 'name': 'Canal Nueva', 'category_id': 'nueva'},
        {'stream_id': 2, 'name': 'Canal Alfa', 'category_id': 'alfa'},
        {'stream_id': 3, 'name': 'Canal Zeta', 'category_id': 'zeta'},
    ]
    # 'USA Nueva' no está en category_order: debe ir al final, después de las listadas,
    # respetando el orden explícito (Zeta antes que Alfa) para las que sí están.
    categories = {'nueva': 'USA Nueva', 'alfa': 'USA Alfa', 'zeta': 'USA Zeta'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    lineas = [l for l in _playlist(tmp_path, 'luis').splitlines() if l.startswith('#EXTINF')]
    grupos = [l.split('group-title="')[1].split('"')[0] for l in lineas]
    assert grupos == ['USA Zeta', 'USA Alfa', 'USA Nueva']


def test_category_order_ignora_emoji_acentos_y_mayusculas(tmp_path, monkeypatch):
    """El proveedor puede cambiar el emoji de una categoría; category_order debe seguir
    reconociéndola por el texto, no por el símbolo exacto que se haya tipeado."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    sections = {
        'order': ['ENGLISH'],
        'rules': [{'section': 'ENGLISH', 'starts_with': ['usa'],
                   'category_order': ['⚽️ USA Zeta', '🏈 USA Alfa']}],
    }
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(sections), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [
        {'stream_id': 1, 'name': 'Canal Alfa', 'category_id': 'alfa'},
        {'stream_id': 2, 'name': 'Canal Zeta', 'category_id': 'zeta'},
    ]
    # El proveedor devuelve otro emoji distinto al tipeado en category_order.
    categories = {'alfa': '🏈 USA Alfa', 'zeta': '🎥 USA Zeta'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    lineas = [l for l in _playlist(tmp_path, 'luis').splitlines() if l.startswith('#EXTINF')]
    grupos = [l.split('group-title="')[1].split('"')[0] for l in lineas]
    assert grupos == ['🎥 USA Zeta', '🏈 USA Alfa']


def test_alternativa_ambigua_queda_etiquetada(proyecto, monkeypatch):
    """TBS existe en dos países: la alternativa entra en la guía con su país entre corchetes."""
    _correr(monkeypatch, PERFILES[:1])
    with gzip.open(proyecto / 'out' / 'luis' / 'epg.xml.gz', 'rb') as f:
        root = etree.fromstring(f.read())
    nombres = [c.find('display-name').text for c in root.findall('channel')]
    assert '[MX] TBS' in nombres
    assert '[US] TBS' in nombres


def test_categoria_divisor_24_7_se_agrupa_en_su_seccion():
    assert generate_playlist.classify_section('▆▆▆24/7▆▆▆', []) == '24/7'
    assert generate_playlist.classify_section('▆▆▆24 7▆▆▆', []) == '24/7'


def test_sin_perfiles_no_genera_nada(proyecto, monkeypatch, capsys):
    monkeypatch.delenv('XTREAM_PROFILES', raising=False)
    generate_playlist.generate()
    assert not (proyecto / 'out').exists()
    assert 'Sin perfiles configurados' in capsys.readouterr().out
