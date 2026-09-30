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
    {'stream_id': 1, 'name': 'TBS -EN', 'category_id': '1', 'container_extension': 'ts',
     'stream_icon': 'http://xtream/tbs.png'},
    {'stream_id': 2, 'name': 'Warner TV Costa Rica', 'category_id': '2'},
    {'stream_id': 3, 'name': 'Canal Inexistente', 'category_id': '2',
     'stream_icon': 'http://xtream/generico.png'},
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


def test_canal_sin_match_no_lleva_logo(proyecto, monkeypatch):
    """El stream_icon que trae Xtream para un canal sin match confirmado no debería mostrarse:
    da a entender que el canal tiene EPG asignado cuando no lo tiene."""
    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(proyecto, 'luis')
    linea = next(l for l in playlist.splitlines() if 'tvg-id="Canal Inexistente"' in l)
    assert 'tvg-logo=""' in linea
    assert 'http://xtream/generico.png' not in playlist


def test_canal_con_match_conserva_su_logo(proyecto, monkeypatch):
    """Con match confirmado, el logo sigue siendo el del EPG (o el de Xtream si el EPG no
    trae ícono para ese canal)."""
    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(proyecto, 'luis')
    linea = next(l for l in playlist.splitlines() if 'tvg-id="TBS.us"' in l)
    assert 'tvg-logo="http://logo/tbs.png"' in linea


def test_catalogo_del_epg_incluye_todos_los_canales_sin_credenciales(proyecto, monkeypatch):
    """El catálogo alimenta la interfaz de corrección manual (docs/): tiene que cubrir TODO el
    EPG (no solo lo matcheado) y no puede llevar nada de las credenciales de ningún perfil."""
    _correr(monkeypatch, PERFILES)
    with open(proyecto / 'out' / 'epg_catalog.json', encoding='utf-8') as f:
        catalogo = json.load(f)
    ids = {c['id'] for c in catalogo}
    assert ids == {'TBS.us', 'TBS.mx', 'Warner.cr'}
    tbs_us = next(c for c in catalogo if c['id'] == 'TBS.us')
    # sched es None: los programas de MERGED están fechados en 2024, fuera de la ventana de
    # "ahora" que usa write_schedule_snapshot (ver test aparte con `now` controlado).
    assert tbs_us == {'id': 'TBS.us', 'name': 'TBS', 'country': 'us', 'source': 'acidjesuz-us',
                       'sched': None}
    crudo = (proyecto / 'out' / 'epg_catalog.json').read_text(encoding='utf-8')
    assert 'clave-de-luis' not in crudo and 'clave-de-juan' not in crudo


def test_parse_xmltv_time_convierte_offset_a_utc():
    dt = generate_playlist._parse_xmltv_time('20260101120000 -0300')
    assert dt == generate_playlist.datetime.datetime(
        2026, 1, 1, 15, 0, tzinfo=generate_playlist.datetime.timezone.utc)


def test_parse_xmltv_time_sin_offset_asume_utc():
    dt = generate_playlist._parse_xmltv_time('20260101120000')
    assert dt == generate_playlist.datetime.datetime(
        2026, 1, 1, 12, 0, tzinfo=generate_playlist.datetime.timezone.utc)


def test_parse_xmltv_time_formato_invalido_devuelve_none():
    assert generate_playlist._parse_xmltv_time('no es una fecha') is None
    assert generate_playlist._parse_xmltv_time('') is None


def test_schedule_snapshot_solo_incluye_la_ventana_de_ahora(tmp_path):
    """La interfaz de corrección necesita "qué está dando ahora", no la guía completa: un
    programa que ya terminó o que empieza muy lejos en el futuro no debe publicarse."""
    now = generate_playlist.datetime.datetime(
        2026, 1, 1, 12, 0, tzinfo=generate_playlist.datetime.timezone.utc)
    root = etree.fromstring("""<tv>
      <programme channel="A.us" start="20260101110000 +0000" stop="20260101120000 +0000">
        <title>Ya casi termina, todavia en curso</title></programme>
      <programme channel="A.us" start="20260101130000 +0000" stop="20260101140000 +0000">
        <title>Mas tarde hoy</title></programme>
      <programme channel="A.us" start="20260103000000 +0000" stop="20260103010000 +0000">
        <title>Muy lejos, fuera de ventana</title></programme>
      <programme channel="B.us" start="20260101100000 +0000" stop="20260101103000 +0000">
        <title>Ya termino, fuera de ventana</title></programme>
    </tv>""")
    sched = generate_playlist.write_schedule_snapshot(root, out_dir=str(tmp_path), now=now)
    assert set(sched) == {'A.us'}
    with open(tmp_path / f"{sched['A.us']}.json", encoding='utf-8') as f:
        entries = json.load(f)
    assert [e[2] for e in entries] == ['Ya casi termina, todavia en curso', 'Mas tarde hoy']


def test_schedule_snapshot_incluye_la_descripcion(tmp_path):
    """La interfaz muestra la sinopsis del programa en el aire: va como cuarto elemento solo
    cuando la guía la trae (si no, el nombre del episodio), con espacios normalizados y recortada
    si es muy larga. El índice por hora no la lleva: es el que se baja entero."""
    now = generate_playlist.datetime.datetime(
        2026, 1, 1, 12, 0, tzinfo=generate_playlist.datetime.timezone.utc)
    larga = 'x' * (generate_playlist.SCHEDULE_DESC_MAX + 50)
    root = etree.fromstring(f"""<tv>
      <programme channel="A.us" start="20260101113000 +0000" stop="20260101123000 +0000">
        <title>Noticias</title><desc>  Resumen   del
        dia  </desc></programme>
      <programme channel="A.us" start="20260101123000 +0000" stop="20260101130000 +0000">
        <title>Friends</title><sub-title>The One with the Thumb</sub-title></programme>
      <programme channel="A.us" start="20260101130000 +0000" stop="20260101140000 +0000">
        <title>Sin datos</title></programme>
      <programme channel="A.us" start="20260101140000 +0000" stop="20260101150000 +0000">
        <title>Pelicula</title><desc>{larga}</desc></programme>
    </tv>""")
    sched = generate_playlist.write_schedule_snapshot(root, out_dir=str(tmp_path), now=now)
    with open(tmp_path / f"{sched['A.us']}.json", encoding='utf-8') as f:
        entries = json.load(f)
    assert entries[0][3] == 'Resumen del dia'
    assert entries[1][3] == 'The One with the Thumb'
    assert len(entries[2]) == 3
    assert len(entries[3][3]) == generate_playlist.SCHEDULE_DESC_MAX and entries[3][3].endswith('…')
    with open(tmp_path / 'hour' / '2026010112.json', encoding='utf-8') as f:
        assert all(len(e) == 3 for e in json.load(f)['c']['A.us'])


def test_schedule_snapshot_arma_indice_por_hora(tmp_path):
    """El buscador de la interfaz baja un solo archivo (el de la hora actual) para mostrar qué
    está dando cada canal del catálogo y poder buscar por programa: cada hora tiene que traer
    todos los programas que se solapan con ella, y ninguno que no."""
    now = generate_playlist.datetime.datetime(
        2026, 1, 1, 12, 0, tzinfo=generate_playlist.datetime.timezone.utc)
    root = etree.fromstring("""<tv>
      <programme channel="A.us" start="20260101113000 +0000" stop="20260101123000 +0000">
        <title>Noticias</title></programme>
      <programme channel="A.us" start="20260101123000 +0000" stop="20260101130000 +0000">
        <title>Friends</title></programme>
      <programme channel="B.us" start="20260101120000 +0000" stop="20260101140000 +0000">
        <title>Friends</title></programme>
    </tv>""")
    generate_playlist.write_schedule_snapshot(root, out_dir=str(tmp_path), now=now)

    def hora(nombre):
        with open(tmp_path / 'hour' / f'{nombre}.json', encoding='utf-8') as f:
            data = json.load(f)
        return {cid: [data['t'][e[2]] for e in entries] for cid, entries in data['c'].items()}

    assert hora('2026010111') == {'A.us': ['Noticias']}
    with open(tmp_path / 'hour' / '2026010112.json', encoding='utf-8') as f:
        data = json.load(f)
    assert data['h'] == int(now.timestamp())
    # inicio/fin en minutos relativos a la hora del archivo
    assert [e[:2] for e in data['c']['A.us']] == [[-30, 30], [30, 60]]
    assert hora('2026010112') == {'A.us': ['Noticias', 'Friends'], 'B.us': ['Friends']}
    assert hora('2026010113') == {'B.us': ['Friends']}
    assert hora('2026010114') == {}


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


def test_order_de_secciones_acepta_formato_numerico(tmp_path, monkeypatch):
    """'order' también acepta {"sección": número}, igual que category_order."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    sections = {
        'order': {'PAÍSES': 10, 'ENGLISH': 20},
        'rules': SECTIONS['rules'],
    }
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(sections), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], STREAMS))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: CATEGORIES)

    _correr(monkeypatch, PERFILES[:1])
    lineas = [l for l in _playlist(tmp_path, 'luis').splitlines() if l.startswith('#EXTINF')]
    grupos = [l.split('group-title="')[1].split('"')[0] for l in lineas]
    assert grupos[0] == '🇨🇷 COSTA RICA', "PAÍSES (10) va antes que ENGLISH (20)"


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


def test_category_order_acepta_formato_numerico_con_huecos(tmp_path, monkeypatch):
    """category_order también acepta {"nombre": numero}, más fácil de reordenar insertando un
    número entre dos existentes en vez de mover líneas de una lista."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    sections = {
        'order': ['ENGLISH'],
        'rules': [{'section': 'ENGLISH', 'starts_with': ['usa'],
                   'category_order': {'USA Zeta': 10, 'USA Alfa': 20, 'USA Beta': 15}}],
    }
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(sections), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [
        {'stream_id': 1, 'name': 'Canal Alfa', 'category_id': 'alfa'},
        {'stream_id': 2, 'name': 'Canal Beta', 'category_id': 'beta'},
        {'stream_id': 3, 'name': 'Canal Zeta', 'category_id': 'zeta'},
    ]
    categories = {'alfa': 'USA Alfa', 'beta': 'USA Beta', 'zeta': 'USA Zeta'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    lineas = [l for l in _playlist(tmp_path, 'luis').splitlines() if l.startswith('#EXTINF')]
    grupos = [l.split('group-title="')[1].split('"')[0] for l in lineas]
    assert grupos == ['USA Zeta', 'USA Beta', 'USA Alfa']


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


def test_separador_de_seccion_no_se_matchea_contra_el_epg(proyecto, monkeypatch):
    """Bug real: el placeholder "== 24 /7 Only ==" y un canal real "COCINA 24/7" matcheaban los
    dos, por puntaje débil, al mismo channel_id ("CBS News 24/7.us") — dos entradas del M3U
    con el mismo tvg-id, y TiviMate esconde una de las dos. La categoría divisor nunca debe
    entrar al matcher: acá se prueba con un nombre que matchearía fuerte (TBS) para confirmar
    que ni así se le asigna un channel_id."""
    streams = [
        {'stream_id': 1, 'name': 'TBS', 'category_id': 'div'},  # matchearía fuerte si se probara
        {'stream_id': 2, 'name': 'TBS', 'category_id': 'real'},
    ]
    categories = {'div': '▆▆▆Divisor▆▆▆', 'real': 'Real'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(proyecto, 'luis')
    tvg_ids = [l.split('tvg-id="')[1].split('"')[0] for l in playlist.splitlines()
               if l.startswith('#EXTINF')]
    assert len(tvg_ids) == len(set(tvg_ids)), f"tvg-id duplicado entre entradas: {tvg_ids}"
    assert any(tid.startswith('TBS.') for tid in tvg_ids), "el canal real sí debe matchear contra el EPG"


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


def test_group_title_sin_barra_confirmado_tivimate_la_esconde():
    """TiviMate no muestra ninguna categoría cuyo group-title tenga una barra, normal o de
    ancho completo (probado a mano); se reemplaza por un guion antes de publicar."""
    assert generate_playlist._safe_group_title('▆▆▆２４／７▆▆▆') == '▆▆▆２４-７▆▆▆'
    assert generate_playlist._safe_group_title('Acción/Aventura') == 'Acción-Aventura'
    assert generate_playlist._safe_group_title('PPV Futbol') == 'PPV Futbol'


def test_prefijo_del_proveedor_se_saca_del_nombre_mostrado(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    sections = {'order': ['ENGLISH'], 'rules': [{'section': 'ENGLISH', 'starts_with': ['usa']}]}
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(sections), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [{'stream_id': 1, 'name': 'USA| TBS', 'category_id': 'us'}]
    categories = {'us': 'USA Entertainment'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(tmp_path, 'luis')
    assert 'USA| TBS' not in playlist
    assert 'tvg-name="TBS"' in playlist
    assert 'tvg-id="TBS.us"' in playlist, \
        "el país que decía el prefijo (us) debe seguir ayudando al match aunque se saque del nombre"


def test_override_sigue_usando_el_nombre_crudo_con_prefijo(tmp_path, monkeypatch):
    """Los overrides de xtream_channel_map.json se configuran copiando el nombre tal cual
    aparece en Xtream (con su prefijo); recortar el nombre para mostrar no debe romperlos."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    sections = {'order': ['ENGLISH'], 'rules': [{'section': 'ENGLISH', 'starts_with': ['usa']}]}
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(sections), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text(
        json.dumps({'overrides': {'USA| TBS': 'Warner.cr'}}), encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [{'stream_id': 1, 'name': 'USA| TBS', 'category_id': 'us'}]
    categories = {'us': 'USA Entertainment'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(tmp_path, 'luis')
    assert 'tvg-id="Warner.cr"' in playlist


def test_override_en_null_fuerza_sin_epg_ni_logo(tmp_path, monkeypatch):
    """Desde la interfaz de corrección se puede elegir "forzar sin EPG": un override en `null`
    en vez de un channel_id. Tiene que ganarle al matching automático (que para "TBS -EN"
    normalmente encontraría TBS.us con score alto) y al fallback de epg_channel_id."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    sections = {'order': ['ENGLISH'], 'rules': [{'section': 'ENGLISH', 'starts_with': ['usa']}]}
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(sections), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text(
        json.dumps({'overrides': {'USA| TBS -EN': None}}), encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [{'stream_id': 1, 'name': 'USA| TBS -EN', 'category_id': 'us',
                'stream_icon': 'http://xtream/tbs.png', 'epg_channel_id': 'TBS.us'}]
    categories = {'us': 'USA Entertainment'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(tmp_path, 'luis')
    assert 'tvg-id="TBS.us"' not in playlist
    assert 'tvg-logo=""' in playlist

    canales = {c['xtream_name']: c for c in _reporte(tmp_path, 'luis')['channels']}
    canal = canales['USA| TBS -EN']
    assert canal['chosen'] is None
    assert canal['reason'] == 'override_none'


def test_override_en_null_no_cuenta_como_sin_matchear(tmp_path, monkeypatch):
    """Es una decisión deliberada, no un hueco a revisar: no debe inflar el conteo de
    "sin match" del reporte."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    sections = {'order': ['ENGLISH'], 'rules': [{'section': 'ENGLISH', 'starts_with': ['usa']}]}
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(sections), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text(
        json.dumps({'overrides': {'USA| TBS -EN': None}}), encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [{'stream_id': 1, 'name': 'USA| TBS -EN', 'category_id': 'us'}]
    categories = {'us': 'USA Entertainment'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    assert _reporte(tmp_path, 'luis')['stats']['unmatched'] == 0


def test_la_playlist_no_lleva_barras_en_group_title(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(SECTIONS), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [{'stream_id': 1, 'name': 'Canal Alfa', 'category_id': 'usa'}]
    categories = {'usa': 'USA Acción／Aventura'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(tmp_path, 'luis')
    assert 'USA Acción／Aventura' not in playlist
    assert 'USA Acción-Aventura' in playlist


def test_divisor_24_7_mantiene_el_estilo_decorativo_sin_la_barra(tmp_path, monkeypatch):
    """La barra del separador original del proveedor ("▆▆▆２４／７▆▆▆") era lo que TiviMate
    escondía (confirmado a mano); se mantiene el mismo estilo que las demás secciones pero sin
    la barra, en vez de texto plano."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    sections = {
        'order': ['24/7'],
        'rules': [{'section': '24/7', 'starts_with': ['24 7']}],
    }
    (tmp_path / 'playlist_sections.json').write_text(json.dumps(sections), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))

    streams = [{'stream_id': 1, 'name': 'Canal Divisor', 'category_id': 'divisor'}]
    categories = {'divisor': '▆▆▆２４／７▆▆▆'}
    monkeypatch.setattr(generate_playlist, 'get_live_streams',
                        lambda servers, u, p, **kw: (servers[0], streams))
    monkeypatch.setattr(generate_playlist, 'get_live_categories',
                        lambda s, u, p, **kw: categories)

    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(tmp_path, 'luis')
    assert '▆▆▆２４／７▆▆▆' not in playlist, "el original con barra no debe quedar en ningún lado"
    assert 'group-title="▆▆▆２４ ７▆▆▆"' in playlist
    # El nombre crudo puede seguir siendo el tvg-id (invisible, solo hace falta que sea único),
    # pero no debe quedar visible ni como tvg-name ni como el texto que se muestra.
    assert 'tvg-name="Canal Divisor"' not in playlist
    assert ',Canal Divisor' not in playlist
    assert 'tvg-name="▆▆▆２４ ７▆▆▆"' in playlist


def test_sin_perfiles_no_genera_nada(proyecto, monkeypatch, capsys):
    monkeypatch.delenv('XTREAM_PROFILES', raising=False)
    generate_playlist.generate()
    assert not (proyecto / 'out').exists()
    assert 'Sin perfiles configurados' in capsys.readouterr().out


def _con_ediciones(proyecto, overrides=None, renames=None, categorias=None, ocultos=None,
                   categorias_ocultas=None):
    (proyecto / 'xtream_channel_map.json').write_text(json.dumps({
        'overrides': overrides or {}, 'renames': renames or {}, 'categories': categorias or {},
        'hidden': {n: True for n in ocultos or []},
        'hidden_categories': {c: True for c in categorias_ocultas or []},
    }), encoding='utf-8')


def _extinf(playlist, nombre):
    return next(l for l in playlist.splitlines() if l.startswith('#EXTINF') and l.endswith(',' + nombre))


def test_renombrar_cambia_solo_el_nombre_visible(proyecto, monkeypatch):
    """El renombrado (armable desde la interfaz) cambia tvg-name y el título, pero el matching
    y los overrides siguen yendo por el nombre crudo de Xtream."""
    _con_ediciones(proyecto, overrides={'Canal Inexistente': 'Warner.cr'},
                   renames={'TBS -EN': 'TBS USA', 'Canal Inexistente': 'Mi Warner'})
    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(proyecto, 'luis')
    assert 'tvg-id="TBS.us" tvg-name="TBS USA"' in _extinf(playlist, 'TBS USA')
    assert 'tvg-id="Warner.cr"' in _extinf(playlist, 'Mi Warner'), "el override sigue aplicando"
    assert ',TBS -EN' not in playlist
    canales = {c['xtream_name']: c for c in _reporte(proyecto, 'luis')['channels']}
    assert canales['TBS -EN']['chosen'] == 'TBS.us'


def test_mover_de_categoria_cambia_grupo_y_orden_pero_no_el_epg(proyecto, monkeypatch):
    _con_ediciones(proyecto, categorias={'TBS -EN': '🇨🇷 COSTA RICA'})
    _correr(monkeypatch, PERFILES[:1])
    lineas = [l for l in _playlist(proyecto, 'luis').splitlines() if l.startswith('#EXTINF')]
    grupos = [l.split('group-title="')[1].split('"')[0] for l in lineas]
    assert grupos == ['🇨🇷 COSTA RICA'] * 3, "ya no queda nada en USA ENTERTAINMENT"
    # El EPG se sigue eligiendo con la categoría original (ENGLISH prefiere acidjesuz-us).
    canales = {c['xtream_name']: c for c in _reporte(proyecto, 'luis')['channels']}
    assert canales['TBS -EN']['chosen'] == 'TBS.us'
    assert canales['TBS -EN']['category'] == 'USA ENTERTAINMENT'
    assert canales['TBS -EN']['section'] == 'ENGLISH'


def test_mover_a_un_separador_se_ignora(proyecto, monkeypatch):
    _con_ediciones(proyecto, categorias={'TBS -EN': '▆▆▆ＰＰＶ　ＥＶＥＮＴＳ▆▆▆'})
    _correr(monkeypatch, PERFILES[:1])
    assert 'group-title="USA ENTERTAINMENT"' in _extinf(_playlist(proyecto, 'luis'), 'TBS -EN')


def test_canal_oculto_sale_de_playlist_y_guia_pero_queda_en_el_reporte(proyecto, monkeypatch):
    """Oculto desde la interfaz: no aparece en la playlist ni su EPG en la guía del perfil,
    pero sigue en el reporte (con su EPG calculado) para poder volver a mostrarlo."""
    _con_ediciones(proyecto, ocultos=['Warner TV Costa Rica'])
    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(proyecto, 'luis')
    assert 'Warner TV Costa Rica' not in playlist
    assert 'TBS -EN' in playlist
    with gzip.open(proyecto / 'out' / 'luis' / 'epg.xml.gz', 'rb') as f:
        root = etree.fromstring(f.read())
    assert 'Warner.cr' not in {c.get('id') for c in root.findall('channel')}
    canales = {c['xtream_name']: c for c in _reporte(proyecto, 'luis')['channels']}
    assert canales['Warner TV Costa Rica']['chosen'] == 'Warner.cr'


def test_categoria_oculta_saca_todos_sus_canales(proyecto, monkeypatch):
    """Una categoría entera oculta desde la interfaz: sus canales salen de la playlist y la
    guía pero siguen en el reporte. Un canal movido desde ahí a otra categoría visible, sigue."""
    _con_ediciones(proyecto, categorias_ocultas=['USA ENTERTAINMENT'])
    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(proyecto, 'luis')
    assert 'group-title="USA ENTERTAINMENT"' not in playlist
    assert 'Warner TV Costa Rica' in playlist
    canales = {c['xtream_name']: c for c in _reporte(proyecto, 'luis')['channels']}
    assert canales['TBS -EN']['chosen'] == 'TBS.us', "sigue en el reporte con su EPG"

    _con_ediciones(proyecto, categorias_ocultas=['USA ENTERTAINMENT'],
                   categorias={'TBS -EN': '🇨🇷 COSTA RICA'})
    _correr(monkeypatch, PERFILES[:1])
    assert 'group-title="🇨🇷 COSTA RICA"' in _extinf(_playlist(proyecto, 'luis'), 'TBS -EN')


def test_perfil_m3u_genera_lista_guia_y_reporte(proyecto, monkeypatch):
    """Una lista M3U cualquiera (no Xtream) pasa por el mismo matching: group-title es la
    categoría, las URLs de stream se conservan tal cual y el tvg-id de la lista solo se usa
    como sugerencia verificada."""
    (proyecto / 'lista.m3u').write_text('''#EXTM3U
#EXTINF:-1 group-title="USA ENTERTAINMENT",TBS -EN
http://otro-proveedor/tbs.m3u8?token=secreto
#EXTINF:-1 tvg-id="Warner.cr" group-title="🇨🇷 COSTA RICA",Warner Costa Rica
http://otro-proveedor/warner.m3u8?token=secreto
''', encoding='utf-8')
    _correr(monkeypatch, [{'name': 'm3u', 'type': 'm3u', 'url': str(proyecto / 'lista.m3u')}])
    playlist = _playlist(proyecto, 'm3u')
    assert 'tvg-id="TBS.us"' in _extinf(playlist, 'TBS -EN')
    assert 'http://otro-proveedor/tbs.m3u8?token=secreto' in playlist
    assert 'group-title="🇨🇷 COSTA RICA"' in _extinf(playlist, 'Warner Costa Rica')
    canales = {c['xtream_name']: c for c in _reporte(proyecto, 'm3u')['channels']}
    assert canales['Warner Costa Rica']['chosen'] == 'Warner.cr'
    assert 'secreto' not in json.dumps(_reporte(proyecto, 'm3u')), "el reporte no lleva URLs"
    with gzip.open(proyecto / 'out' / 'm3u' / 'epg.xml.gz', 'rb') as f:
        root = etree.fromstring(f.read())
    assert {'TBS.us', 'Warner.cr'} <= {c.get('id') for c in root.findall('channel')}


def test_sin_reglas_del_proveedor_todo_es_generico(tmp_path, monkeypatch):
    """Otro proveedor, sin provider_rules.json: ningún separador especial y las categorías sin
    sección van en el orden en que las lista el proveedor (no alfabético)."""
    monkeypatch.setattr(generate_playlist, 'PROVIDER_RULES_PATH', str(tmp_path / 'no-existe.json'))
    monkeypatch.chdir(tmp_path)
    (tmp_path / 'epg_urls.json').write_text(json.dumps(SOURCES), encoding='utf-8')
    (tmp_path / 'xtream_channel_map.json').write_text('{"overrides": {}}', encoding='utf-8')
    with gzip.open(tmp_path / 'merged.xml.gz', 'wb') as f:
        f.write(MERGED.encode('utf-8'))
    (tmp_path / 'lista.m3u').write_text('''#EXTM3U
#EXTINF:-1 group-title="Zeta",Canal Z
http://p/z
#EXTINF:-1 group-title="▆▆▆ Alfa ▆▆▆",Canal A
http://p/a
#EXTINF:-1 group-title="Medio",Canal M
http://p/m
''', encoding='utf-8')
    _correr(monkeypatch, [{'name': 'otro', 'type': 'm3u', 'url': str(tmp_path / 'lista.m3u')}])
    lineas = [l for l in _playlist(tmp_path, 'otro').splitlines() if l.startswith('#EXTINF')]
    grupos = [l.split('group-title="')[1].split('"')[0] for l in lineas]
    assert grupos == ['Zeta', '▆▆▆ Alfa ▆▆▆', 'Medio'], "orden del proveedor, sin tratar ▆ como separador"
    assert lineas[1].endswith(',Canal A'), "sin reglas, la categoría decorativa es una categoría común"


def test_reglas_del_proveedor_se_mezclan_sobre_las_genericas(tmp_path):
    (tmp_path / 'r.json').write_text(json.dumps({'_comment': 'x', 'category_order': 'alphabetical',
                                                  'no_epg': {'categories': ['General']}}), encoding='utf-8')
    reglas = generate_playlist.load_provider_rules(str(tmp_path / 'r.json'))
    assert reglas['category_order'] == 'alphabetical'
    assert reglas['no_epg'] == {'categories': ['General'], 'sections': [], 'category_patterns': []}
    assert reglas['dividers']['pattern'] is None
    assert '_comment' not in reglas


def test_logos_del_epg_para_la_interfaz(proyecto, monkeypatch):
    """epg_icons.json: solo canales con logo, y siempre por https (la interfaz se sirve por https)."""
    _correr(monkeypatch, PERFILES[:1])
    with open(proyecto / 'out' / 'epg_icons.json', encoding='utf-8') as f:
        icons = json.load(f)
    assert icons == {'TBS.us': 'https://logo/tbs.png'}


def test_pais_del_tvg_id():
    assert generate_playlist.tvg_id_country('Clan.es@SD') == 'es'
    assert generate_playlist.tvg_id_country('Telefe.ar') == 'ar'
    assert generate_playlist.tvg_id_country('I245.11164.schedulesdirect.org') is None
    assert generate_playlist.tvg_id_country(None) is None


def _idx(*channels):
    from lxml import etree
    from epg_index import EpgIndex
    xml = '<tv>' + ''.join(f'<channel id="{cid}"><display-name>{n}</display-name></channel>'
                           for cid, n in channels) + '</tv>'
    return EpgIndex(etree.fromstring(xml))


def test_tvg_id_desempata_el_pais():
    """"Clan (1080p)" de la lista de España iba a Clan.ar: el tvg-id dice que es de España."""
    idx = _idx(('Clan.ar', 'Clan'), ('Clan.es', 'Clan'))
    _, cid, _, _, _ = generate_playlist.match_stream('Clan (1080p)', 'Clan.es@SD', idx, {}, {}, None)
    assert cid == 'Clan.es'


def test_tvg_id_gana_sobre_un_match_por_nombre_dudoso():
    idx = _idx(('TelefeRosario.ar', 'Telefe Rosario'), ('Rosario.TV.ar', 'Rosario Noticias TV'))
    _, cid, reason, score, _ = generate_playlist.match_stream(
        'Telefe Rosario (720p) [Geo-blocked]', 'TelefeRosario.ar@SD', idx, {}, {}, None)
    assert cid == 'TelefeRosario.ar'


def test_bien_requiere_que_el_nombre_coincida():
    """El refuerzo por país elige entre candidatos, pero un nombre que coincide a medias
    ("RTL 102.5 Disco" vs "RTL 102.5") queda "Dudoso" (< 0.8) para revisarlo."""
    idx = _idx(('RTL.102.5.it', 'RTL 102.5'), ('Disco.it', 'Radio Disco'), ('RTL.de', 'RTL'), ('Canale.5.it', 'Canale 5'))
    _, cid, _, score, ranked = generate_playlist.match_stream('RTL 102.5 Disco', None, idx, {}, {'country': 'it'}, None)
    assert ranked[0].score >= 0.8, "sin calibrar, el refuerzo por país lo dejaba como Bien"
    assert cid == 'RTL.102.5.it'
    assert score < 0.8


def test_en_xtream_el_id_del_proveedor_no_da_pais():
    """El epg_channel_id de Xtream es una adivinanza del proveedor: su ".mx" no puede mandar un
    canal panregional a la guía mexicana (pasó con 300 canales de Luis)."""
    idx = _idx(('Amc.ar', 'AMC'), ('amc.mx', 'AMC'))
    _, m3u, _, _, _ = generate_playlist.match_stream('AMC', 'amc.mx', idx, {}, {}, None, trust_list_ids=True)
    _, xtream, _, _, _ = generate_playlist.match_stream('AMC', 'amc.mx', idx, {}, {}, None, trust_list_ids=False)
    assert m3u == 'amc.mx'
    assert xtream == 'Amc.ar', "sin pista de país gana la primera fuente, como antes"


def test_rtl_zwei_no_va_a_srf_zwei():
    idx = _idx(('RTLZWEI.de', 'RTLZWEI'), ('SRF.zwei.de', 'SRF zwei'), ('RTL.de', 'RTL'))
    _, cid, _, _, _ = generate_playlist.match_stream('RTL Zwei', None, idx, {}, {'country': 'de'}, None)
    assert cid == 'RTLZWEI.de'


def test_umbral_generico_no_asigna_matches_flojos():
    """Sin provider_rules.json no se asigna nada debajo de 0.7 (acierta ~20 %); con las reglas
    de este repo (0.45) se asigna como siempre."""
    idx = _idx(('Onda.Algeciras.TV.es', 'Onda Algeciras TV'), ('Canal.Sur.es', 'Canal Sur'))
    try:
        generate_playlist.set_provider_rules(generate_playlist.load_provider_rules('/no/existe.json'))
        _, generico, _, _, _ = generate_playlist.match_stream('Onda 15 TV', None, idx, {}, {}, None)
    finally:
        generate_playlist.set_provider_rules(generate_playlist.load_provider_rules())
    _, luis, _, score, _ = generate_playlist.match_stream('Onda 15 TV', None, idx, {}, {}, None)
    assert generico is None
    assert luis == 'Onda.Algeciras.TV.es' and score < 0.7


def test_exporta_para_grilla_web_lo_mismo_que_la_playlist(proyecto, monkeypatch):
    """grilla_import.json (para "Importar desde Grilla (GitHub)" en la web): mismo orden de
    categorías que la playlist y las ediciones de cada canal, sin URLs ni credenciales."""
    _con_ediciones(proyecto, overrides={'Canal Inexistente': 'Warner.cr'},
                   renames={'TBS -EN': 'TBS USA'}, ocultos=['Warner TV Costa Rica'])
    _correr(monkeypatch, PERFILES[:1])
    playlist = _playlist(proyecto, 'luis')
    data = json.loads((proyecto / 'out' / 'luis' / 'grilla_import.json').read_text(encoding='utf-8'))

    grupos_playlist = []
    for l in playlist.splitlines():
        if l.startswith('#EXTINF'):
            g = l.split('group-title="')[1].split('"')[0]
            if g not in grupos_playlist:
                grupos_playlist.append(g)
    visibles = [g for g in data['groups']['order'] if g not in data['groups']['hidden']]
    assert [g.replace('/', '-') for g in visibles if g in grupos_playlist or g.replace('/', '-') in grupos_playlist] == grupos_playlist

    ch = data['channels']
    assert ch['Canal Inexistente'] == {**ch['Canal Inexistente'], 'epg': 'Warner.cr', 'manual': True}
    assert ch['TBS -EN']['name'] == 'TBS USA' and ch['TBS -EN']['epg'] == 'TBS.us' and 'manual' not in ch['TBS -EN']
    assert ch['Warner TV Costa Rica']['hidden'] is True
    texto = json.dumps(data)
    perfil = PERFILES[0]
    assert perfil['password'] not in texto and '/live/' not in texto, 'sin credenciales ni URLs de stream'
