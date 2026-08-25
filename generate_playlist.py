#!/usr/bin/env python3
"""Genera playlist.m3u8 y my_epg.xml.gz cruzando la lista real de canales de
Xtream Codes con el EPG ya generado por merge_epgs.py (merged.xml.gz)."""
import gzip
import json
import os
import re
import unicodedata

import requests
from lxml import etree

from xtream_client import XtreamError, build_stream_url, get_live_categories, get_live_streams

MERGED_EPG_PATH = 'merged.xml.gz'
CHANNEL_MAP_PATH = 'xtream_channel_map.json'
SECTIONS_CONFIG_PATH = 'playlist_sections.json'
PLAYLIST_PATH = 'playlist.m3u8'
FILTERED_EPG_PATH = 'my_epg.xml.gz'

# Sección cuyos canales deben matchear primero contra esta fuente EPG específica de EE.UU.
# (pedido del usuario), y solo si no matchea ahí, caer al índice general de 'us'.
PRIORITY_SECTION = 'ENGLISH'
PRIORITY_EPG_URL = 'https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/US_guide.xml.gz'

SUFFIXES = ('hd', 'fhd', 'uhd', '4k', 'sd', 'hevc')


def _strip_accents(text):
    text = unicodedata.normalize('NFKD', text)
    return ''.join(c for c in text if not unicodedata.combining(c))


# Prefijo de código de país que algunos proveedores anteponen: "PE | ", "CL| ", "B| " (1 a 3 letras + "|")
COUNTRY_PREFIX_RE = re.compile(r'^[A-Za-z]{1,3}\s*\|\s*')

# El channel_id de las fuentes EPG casi siempre termina en el código de país: "Canal.5.mx", "TNT.ar"
CHANNEL_ID_SUFFIX_RE = re.compile(r'\.([a-z]{2})$')


# El sufijo de los channel_id de las fuentes EPG no siempre es ISO-3166 estricto
# (ej. usan "uk" en vez de "gb"). Mapeo de código ISO del emoji -> código real usado en los ids.
COUNTRY_CODE_ALIASES = {'gb': 'uk'}

# Abreviaturas de 2-3 letras que aparecen sueltas dentro del nombre del canal
# (ej. "ESPN 1 ARG", "Fox Sports MX") -> código alineado con el sufijo de channel_id.
COUNTRY_NAME_TOKENS = {
    'arg': 'ar', 'ar': 'ar',
    'chi': 'cl', 'cl': 'cl',
    'per': 'pe', 'pe': 'pe',
    'mex': 'mx', 'mx': 'mx',
    'col': 'co', 'co': 'co',
    'ecu': 'ec', 'ec': 'ec',
    'bol': 'bo', 'bo': 'bo',
    'usa': 'us', 'us': 'us',
    'pan': 'pa', 'panama': 'pa',
    'cri': 'cr', 'cr': 'cr', 'costarica': 'cr',
    'par': 'py', 'py': 'py', 'paraguay': 'py',
    'uru': 'uy', 'uy': 'uy', 'uruguay': 'uy',
    'esp': 'es', 'es': 'es', 'espana': 'es',
    'argentina': 'ar',
    'chile': 'cl',
    'peru': 'pe',
    'mexico': 'mx',
    'colombia': 'co',
    'ecuador': 'ec',
    'bolivia': 'bo',
}
COUNTRY_NAME_TOKEN_RE = re.compile(
    r'\b(' + '|'.join(sorted(COUNTRY_NAME_TOKENS, key=len, reverse=True)) + r')\b',
    re.IGNORECASE,
)


# Categorías "separador" decorativas que el proveedor usa como divisores visuales en su propio
# panel (ej. "▆▆▆ＰＰＶ　ＥＶＥＮＴＳ▆▆▆", con un único canal placeholder tipo "** PPV Events **").
# Se conservan (el usuario las usa para orientarse), pero se reubican como encabezado al
# principio de la sección real que les corresponde.
DIVIDER_CATEGORY_RE = re.compile(r'[▆░▒▓█]')


def is_divider_category(category):
    return bool(DIVIDER_CATEGORY_RE.search(category))


def _divider_key(category):
    """'▆▆▆ＤＥＰＯＲＴＥＳ ▆▆▆' -> 'deportes' (des-fullwidth + solo alfanumérico)."""
    text = unicodedata.normalize('NFKC', category)
    text = _strip_accents(text).lower()
    return re.sub(r'[^a-z0-9]', '', text)


DIVIDER_SECTION_MAP = {
    _divider_key('PPV EVENTS'): 'PPV EVENTS',
    _divider_key('PAISES'): 'PAÍSES',
    _divider_key('DEPORTES'): 'DEPORTES',
    _divider_key('ENGLISH'): 'ENGLISH',
    _divider_key('ESPAÑOL'): 'ESPAÑOL',
    _divider_key('LATINOS USA'): 'LATINOS USA',
}


def _strip_category_label(category):
    """Quita emoji/símbolos iniciales de una categoría para comparar el texto: '🏈 ESPN' -> 'espn'."""
    text = _strip_accents(category).lower()
    text = re.sub(r'^[^a-z0-9]+', '', text)
    return text.strip()


def load_sections_config():
    """Carga playlist_sections.json: orden de secciones + reglas de clasificación."""
    try:
        with open(SECTIONS_CONFIG_PATH, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"⚠️  No se pudo leer {SECTIONS_CONFIG_PATH} ({e}); no se agruparán categorías en secciones")
        return [], []
    return config.get('order', []), config.get('rules', [])


def _make_rule_matcher(rule):
    starts_with = tuple(rule.get('starts_with', []))
    equals = set(rule.get('equals', []))
    country_flag = rule.get('country_flag', False)

    def matcher(cat, label):
        if starts_with and label.startswith(starts_with):
            return True
        if equals and label in equals:
            return True
        if country_flag and flag_to_country_code(cat) is not None:
            return True
        return False

    return matcher


def classify_section(category, section_rules):
    if is_divider_category(category):
        return DIVIDER_SECTION_MAP.get(_divider_key(category))  # None si es un separador sin sección mapeada (ADULTS, 24/7)

    label = _strip_category_label(category)
    for section_name, matcher in section_rules:
        if matcher(category, label):
            return section_name
    return None  # sin sección: se agrupan al final, en orden de aparición original


def flag_to_country_code(text):
    """Extrae el código de país (2 letras, ya alineado con el sufijo de channel_id) del emoji de bandera."""
    codepoints = [ord(c) for c in text]
    for i in range(len(codepoints) - 1):
        a, b = codepoints[i], codepoints[i + 1]
        if 0x1F1E6 <= a <= 0x1F1FF and 0x1F1E6 <= b <= 0x1F1FF:
            code = chr(a - 0x1F1E6 + ord('a')) + chr(b - 0x1F1E6 + ord('a'))
            return COUNTRY_CODE_ALIASES.get(code, code)
    return None


def detect_country(*texts):
    """Busca un código de país conocido en el prefijo 'XX | ' o suelto dentro de cualquiera de los textos."""
    texts = [_strip_accents(t) for t in texts if t]
    for text in texts:
        prefix = COUNTRY_PREFIX_RE.match(text)
        if prefix:
            code = prefix.group(0).strip(' |').lower()
            if code in COUNTRY_NAME_TOKENS:
                return COUNTRY_NAME_TOKENS[code]
    for text in texts:
        m = COUNTRY_NAME_TOKEN_RE.search(text)
        if m:
            return COUNTRY_NAME_TOKENS[m.group(1).lower()]
    return None


def normalize_name(name):
    """Normaliza un nombre de canal para poder compararlo entre fuentes."""
    if not name:
        return ''
    name = COUNTRY_PREFIX_RE.sub('', name)
    name = unicodedata.normalize('NFKD', name)
    name = ''.join(c for c in name if not unicodedata.combining(c))
    name = name.lower()
    name = re.sub(r'\([^)]*\)', ' ', name)
    name = re.sub(r'[^a-z0-9]+', ' ', name)
    # Los tokens de país (arg, chi, mx...) ya se usan por separado para elegir el índice
    # por país (ver detect_country); se excluyen acá para no bloquear el match por texto.
    tokens = [t for t in name.split() if t not in SUFFIXES and t not in COUNTRY_NAME_TOKENS]
    return ' '.join(tokens)


def load_env_servers():
    username = os.environ.get('XTREAM_USERNAME')
    password = os.environ.get('XTREAM_PASSWORD')
    servers_raw = os.environ.get('XTREAM_SERVERS', '')
    servers = [s.strip() for s in servers_raw.split(',') if s.strip()]

    if not username or not password or not servers:
        return None, None, []

    return username, password, servers


def load_channel_map():
    try:
        with open(CHANNEL_MAP_PATH, 'r') as f:
            return json.load(f).get('overrides', {})
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def fetch_priority_us_index(timeout=30):
    """Descarga la fuente EPG de EE.UU. prioritaria (acidjesuz/US_guide) y arma su propio
    índice nombre -> channel_id, para que los canales ENGLISH matcheen ahí primero."""
    try:
        response = requests.get(PRIORITY_EPG_URL, timeout=timeout)
        response.raise_for_status()
        data = gzip.decompress(response.content) if PRIORITY_EPG_URL.endswith('.gz') else response.content
        root = etree.fromstring(data)
    except Exception as e:
        print(f"⚠️  No se pudo descargar la fuente EPG prioritaria de EE.UU. ({e}); se usa solo el índice general")
        return {}

    index = {}
    for channel in root.findall('channel'):
        channel_id = channel.get('id')
        if not channel_id:
            continue
        for display_name in channel.findall('display-name'):
            text = display_name.text or ''
            # Descarta display-names tipo "2.1" (solo el número de canal, sin nombre real)
            if re.fullmatch(r'[\d.]+', text.strip()):
                continue
            normalized = normalize_name(text)
            if normalized and normalized not in index:
                index[normalized] = channel_id

    print(f"🇺🇸 Fuente EPG prioritaria de EE.UU.: {len(index)} nombres indexados de {len(root.findall('channel'))} canales")
    return index


def build_epg_index(epg_root):
    """channels_by_id: channel_id -> icon_src
    name_to_id: nombre_normalizado -> channel_id (global, para categorías sin país detectado)
    name_to_id_by_country: código_país -> {nombre_normalizado: channel_id} (según sufijo del channel_id)
    """
    channels_by_id = {}
    name_to_id = {}
    name_to_id_by_country = {}

    for channel in epg_root.findall('channel'):
        channel_id = channel.get('id')
        if not channel_id:
            continue

        icon_elem = channel.find('icon')
        icon_src = icon_elem.get('src') if icon_elem is not None else ''
        channels_by_id[channel_id] = icon_src

        display_names = [dn.text for dn in channel.findall('display-name')]

        suffix_match = CHANNEL_ID_SUFFIX_RE.search(channel_id)
        # El sufijo del channel_id manda si existe; si no, se busca el país en los display-names
        # (prefijo "XX | " o token suelto), útil para ids sin sufijo como "613" o "BOLIVISION.bo".
        country = suffix_match.group(1) if suffix_match else detect_country(*display_names)

        for name_text in display_names:
            normalized = normalize_name(name_text)
            if not normalized:
                continue
            if normalized not in name_to_id:
                name_to_id[normalized] = channel_id
            if country:
                country_index = name_to_id_by_country.setdefault(country, {})
                if normalized not in country_index:
                    country_index[normalized] = channel_id

    return channels_by_id, name_to_id, name_to_id_by_country


def match_channel(xtream_name, overrides, name_to_id, name_to_id_by_country, country_code, priority_index=None):
    if xtream_name in overrides:
        return overrides[xtream_name]

    normalized = normalize_name(xtream_name)
    # Candidatos a probar en orden: el nombre tal cual y, si termina en " 1" (ej. "espn 1"),
    # también sin el número — muchas fuentes EPG listan el canal principal sin numerar.
    candidates = [normalized]
    if normalized.endswith(' 1'):
        candidates.append(normalized[:-2])

    if priority_index:
        for candidate in candidates:
            if candidate in priority_index:
                return priority_index[candidate]

    if country_code and country_code in name_to_id_by_country:
        # Hay canales indexados para ese país: matchea solo contra ellos, para no
        # confundir p.ej. "Canal 26" de Argentina con uno homónimo de Chile.
        country_index = name_to_id_by_country[country_code]
        for candidate in candidates:
            if candidate in country_index:
                return country_index[candidate]
        return None

    # Sin país detectado, o sin ningún canal de ese país en el EPG (cobertura cero):
    # el índice global es la única opción disponible.
    for candidate in candidates:
        if candidate in name_to_id:
            return name_to_id[candidate]
    return None


def generate():
    username, password, servers = load_env_servers()
    if not username:
        print("ℹ️  XTREAM_USERNAME/PASSWORD/SERVERS no configurados, se omite la playlist de Xtream")
        return

    try:
        active_server, live_streams = get_live_streams(servers, username, password)
    except XtreamError as e:
        print(f"❌ No se pudo obtener la lista de canales de Xtream: {e}")
        return

    categories = get_live_categories(active_server, username, password)
    print(f"📂 Categorías encontradas: {len(categories)}")

    with gzip.open(MERGED_EPG_PATH, 'rb') as f:
        epg_root = etree.fromstring(f.read())

    channels_by_id, name_to_id, name_to_id_by_country = build_epg_index(epg_root)
    overrides = load_channel_map()

    # merge_epgs.py descarta canales sin programas: solo sirve como prioritario un channel_id
    # que de verdad haya sobrevivido y esté en merged.xml.gz (si no, matchearía en falso contra
    # un canal sin datos reales).
    priority_us_index_raw = fetch_priority_us_index()
    priority_us_index = {
        name: cid for name, cid in priority_us_index_raw.items() if cid in channels_by_id
    }
    if priority_us_index_raw:
        print(f"   ({len(priority_us_index)}/{len(priority_us_index_raw)} sobreviven en merged.xml.gz)")

    section_display_order, raw_rules = load_sections_config()
    section_rules = [(rule['section'], _make_rule_matcher(rule)) for rule in raw_rules]

    matched_ids = set()
    unmatched = []
    entries = []  # (section_order, category_order, index_original, líneas m3u)
    section_order = {name: i for i, name in enumerate(section_display_order)}
    no_section_order = len(section_display_order)  # categorías sin sección van al final
    category_first_seen = {}

    for i, stream in enumerate(live_streams):
        category = categories.get(str(stream.get('category_id')), 'General')
        name = stream.get('name', '')
        stream_id = stream.get('stream_id')
        container_ext = stream.get('container_extension', 'm3u8')
        section = classify_section(category, section_rules)

        if section == PRIORITY_SECTION:
            # Toda la sección ENGLISH es contenido de EE.UU. por definición, aunque el nombre
            # del canal no diga "USA" explícitamente (ej. "Movie Channels").
            country_code = 'us'
            priority_index = priority_us_index
        else:
            # Prioridad: país detectado en el propio nombre del canal (más específico, ej. "ESPN 1
            # ARG" dentro de la categoría genérica "ESPN") y si no hay, el de la bandera de la categoría.
            country_code = detect_country(name) or flag_to_country_code(category)
            priority_index = None

        channel_id = match_channel(name, overrides, name_to_id, name_to_id_by_country, country_code, priority_index)
        if channel_id:
            matched_ids.add(channel_id)
            tvg_id = channel_id
            logo = channels_by_id.get(channel_id) or stream.get('stream_icon', '')
        else:
            unmatched.append(name)
            tvg_id = stream.get('epg_channel_id') or name
            logo = stream.get('stream_icon', '')

        stream_url = build_stream_url(active_server, username, password, stream_id, container_ext)
        if is_divider_category(category) and section:
            # Separador mapeado a una sección conocida: va primero, como encabezado.
            cat_order = -1
        else:
            cat_order = category_first_seen.setdefault(category, len(category_first_seen))

        entries.append((
            section_order.get(section, no_section_order),
            cat_order,
            i,
            f'#EXTINF:-1 tvg-id="{tvg_id}" tvg-name="{name}" tvg-logo="{logo}" '
            f'group-title="{category}",{name}\n{stream_url}',
        ))

    entries.sort(key=lambda e: (e[0], e[1], e[2]))

    playlist_lines = ['#EXTM3U'] + [e[3] for e in entries]
    with open(PLAYLIST_PATH, 'w', encoding='utf-8') as f:
        f.write('\n'.join(playlist_lines) + '\n')

    filtered_root = etree.Element('tv', attrib=dict(epg_root.attrib))
    for channel in epg_root.findall('channel'):
        if channel.get('id') in matched_ids:
            filtered_root.append(channel)
    for programme in epg_root.findall('programme'):
        if programme.get('channel') in matched_ids:
            filtered_root.append(programme)

    body = etree.tostring(filtered_root, encoding='utf-8', xml_declaration=False, pretty_print=True)
    output = b'<?xml version="1.0" encoding="UTF-8" ?>\n' + body
    with gzip.open(FILTERED_EPG_PATH, 'wb') as f:
        f.write(output)

    print(f"\n📊 Canales de Xtream: {len(live_streams)}")
    print(f"   Con EPG matcheado: {len(matched_ids)}")
    print(f"   Sin EPG (revisar xtream_channel_map.json si aplica): {len(unmatched)}")
    if unmatched:
        preview = ', '.join(unmatched[:15])
        print(f"   Ejemplos sin match: {preview}")
    print(f"✅ {PLAYLIST_PATH} y {FILTERED_EPG_PATH} generados")


if __name__ == '__main__':
    generate()
