#!/usr/bin/env python3
"""Genera playlist.m3u8 y my_epg.xml.gz cruzando la lista real de canales de
Xtream Codes con el EPG ya generado por merge_epgs.py (merged.xml.gz)."""
import gzip
import json
import os
import re
import unicodedata

from lxml import etree

from xtream_client import XtreamError, build_stream_url, get_live_categories, get_live_streams

MERGED_EPG_PATH = 'merged.xml.gz'
CHANNEL_MAP_PATH = 'xtream_channel_map.json'
PLAYLIST_PATH = 'playlist.m3u8'
FILTERED_EPG_PATH = 'my_epg.xml.gz'

SUFFIXES = ('hd', 'fhd', 'uhd', '4k', 'sd', 'hevc')

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


def flag_to_country_code(text):
    """Extrae el código de país (2 letras, ya alineado con el sufijo de channel_id) del emoji de bandera."""
    codepoints = [ord(c) for c in text]
    for i in range(len(codepoints) - 1):
        a, b = codepoints[i], codepoints[i + 1]
        if 0x1F1E6 <= a <= 0x1F1FF and 0x1F1E6 <= b <= 0x1F1FF:
            code = chr(a - 0x1F1E6 + ord('a')) + chr(b - 0x1F1E6 + ord('a'))
            return COUNTRY_CODE_ALIASES.get(code, code)
    return None


def _strip_accents(text):
    text = unicodedata.normalize('NFKD', text)
    return ''.join(c for c in text if not unicodedata.combining(c))


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


def match_channel(xtream_name, overrides, name_to_id, name_to_id_by_country, country_code):
    if xtream_name in overrides:
        return overrides[xtream_name]

    normalized = normalize_name(xtream_name)

    if country_code and country_code in name_to_id_by_country:
        # Hay canales indexados para ese país: matchea solo contra ellos, para no
        # confundir p.ej. "Canal 26" de Argentina con uno homónimo de Chile.
        return name_to_id_by_country[country_code].get(normalized)

    # Sin país detectado, o sin ningún canal de ese país en el EPG (cobertura cero):
    # el índice global es la única opción disponible.
    return name_to_id.get(normalized)


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

    matched_ids = set()
    playlist_lines = ['#EXTM3U']
    unmatched = []

    for stream in live_streams:
        name = stream.get('name', '')
        stream_id = stream.get('stream_id')
        category = categories.get(str(stream.get('category_id')), 'General')
        container_ext = stream.get('container_extension', 'm3u8')
        # Prioridad: país detectado en el propio nombre del canal (más específico, ej. "ESPN 1 ARG"
        # dentro de la categoría genérica "ESPN") y si no hay, el de la bandera de la categoría.
        country_code = detect_country(name) or flag_to_country_code(category)

        channel_id = match_channel(name, overrides, name_to_id, name_to_id_by_country, country_code)
        if channel_id:
            matched_ids.add(channel_id)
            tvg_id = channel_id
            logo = channels_by_id.get(channel_id) or stream.get('stream_icon', '')
        else:
            unmatched.append(name)
            tvg_id = stream.get('epg_channel_id') or name
            logo = stream.get('stream_icon', '')

        stream_url = build_stream_url(active_server, username, password, stream_id, container_ext)

        playlist_lines.append(
            f'#EXTINF:-1 tvg-id="{tvg_id}" tvg-name="{name}" tvg-logo="{logo}" '
            f'group-title="{category}",{name}'
        )
        playlist_lines.append(stream_url)

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
