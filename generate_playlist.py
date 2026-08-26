#!/usr/bin/env python3
"""Genera playlist.m3u8 y my_epg.xml.gz cruzando la lista real de canales de
Xtream Codes con el EPG ya generado por merge_epgs.py (merged.xml.gz)."""
import gzip
import json
import os
import re
import unicodedata
from collections import defaultdict

from lxml import etree

from epg_http import PRIORITY_EPG_CACHE_PATH, PRIORITY_EPG_URL, download_epg
from xtream_client import XtreamError, build_stream_url, get_live_categories, get_live_streams

MERGED_EPG_PATH = 'merged.xml.gz'
CHANNEL_MAP_PATH = 'xtream_channel_map.json'
SECTIONS_CONFIG_PATH = 'playlist_sections.json'
PLAYLIST_PATH = 'playlist.m3u8'
FILTERED_EPG_PATH = 'my_epg.xml.gz'

# Sección cuyos canales deben matchear primero contra esta fuente EPG específica de EE.UU.
# (pedido del usuario), y solo si no matchea ahí, caer al índice general de 'us'.
PRIORITY_SECTION = 'ENGLISH'

# "en" es la etiqueta de idioma inglés que el proveedor agrega a cada canal ENGLISH (ej. "TBS -EN").
# "es" ya se filtraba antes al ser también el código de país de España (ver COUNTRY_NAME_TOKENS).
SUFFIXES = ('hd', 'fhd', 'uhd', '4k', 'sd', 'hevc', 'en')


def _m3u_attr(value):
    """Sanitiza un valor para un atributo M3U entre comillas dobles. El formato M3U no tiene
    mecanismo de escape estándar, así que un '\"' literal rompería el parseo del reproductor."""
    return (value or '').replace('"', "'").replace('\n', ' ').replace('\r', ' ')


# Cuántos candidatos alternativos incluir (con display-name anotado) en my_epg.xml.gz cuando
# un canal tiene varios EPG posibles (ej. "E!" existe para 17 países/feeds distintos) — sin
# este tope, un solo canal ambiguo podría inflar el EPG filtrado con decenas de candidatos.
MAX_ALT_ENTRIES = 4


# Muchos feeds de EE.UU. duplicados por región (East/West/Pacific) comparten el mismo país
# (.us) — sin esto, dos alternativas realmente distintas se verían idénticas como "(US)".
REGION_HINT_RE = re.compile(r'\b(east|west|pacific|mountain|central)\b', re.IGNORECASE)


def _detect_region_hint(*texts):
    for text in texts:
        if not text:
            continue
        m = REGION_HINT_RE.search(text)
        if m:
            return m.group(1).capitalize()
    return None


def _labeled_candidates(channel_ids, channel_country, channel_region):
    """Etiqueta cada channel_id de la lista; si dos quedan con la misma etiqueta (ej. dos
    entradas ".us" sin feed regional detectado), se les agrega un fragmento del channel_id
    para que sigan siendo distinguibles entre sí en la playlist."""
    labels = [_epg_source_label(cid, channel_country, channel_region) for cid in channel_ids]
    repeated = {label for label in labels if labels.count(label) > 1}
    return [
        (cid, f"{label} · {_shorten_id(cid, 20)}" if label in repeated else label)
        for cid, label in zip(channel_ids, labels)
    ]


# Estas fuentes son exclusivamente de EE.UU., aunque su channel_id no traiga sufijo de país
# (".us") ni texto "East/Pacific/..." que channel_country/channel_region puedan detectar.
_KNOWN_US_ID_SUFFIXES = ('schedulesdirect.org', 'gracenote.com')


def _shorten_id(channel_id, max_len=24):
    """Recorta un channel_id largo sin partirlo a la mitad de una palabra (ej. no dejar
    "...schedulesdire" colgando) — corta en el último '.' o espacio antes del límite."""
    if len(channel_id) <= max_len:
        return channel_id
    cut = channel_id[:max_len]
    last_sep = max(cut.rfind('.'), cut.rfind(' '))
    if last_sep > 8:  # no cortar tan corto que la etiqueta quede sin info útil
        cut = cut[:last_sep]
    return cut + '…'


def _epg_source_label(channel_id, channel_country, channel_region):
    """De dónde salió el EPG asignado, para mostrar entre paréntesis: país + feed regional si
    se pudieron detectar (ej. "US East" vs "US Pacific"), o si no, algo identificable del
    propio channel_id (la URL/fuente original no se conserva más allá de esto una vez mergeada)."""
    country = channel_country.get(channel_id)
    region = channel_region.get(channel_id)
    if not country and channel_id.endswith(_KNOWN_US_ID_SUFFIXES):
        country = 'us'
    if country and region:
        return f"{country.upper()} {region}"
    if country:
        return country.upper()
    if region:
        return region
    return _shorten_id(channel_id)


def _strip_accents(text):
    text = unicodedata.normalize('NFKD', text)
    return ''.join(c for c in text if not unicodedata.combining(c))


# Prefijo de código de país que algunos proveedores anteponen: "PE | ", "CL| ", "B| " (1 a 3 letras + "|")
COUNTRY_PREFIX_RE = re.compile(r'^[A-Za-z]{1,3}\s*\|\s*')

# El channel_id de las fuentes EPG casi siempre termina en el código de país: "Canal.5.mx", "TNT.ar"
CHANNEL_ID_SUFFIX_RE = re.compile(r'\.([a-z]{2})$')

# Formato típico de las fuentes de EE.UU. (Schedules Direct/Gracenote) para afiliadas locales:
# "Laff (WUOA) Birmingham, AL HD" — cadena + call sign entre paréntesis + "Ciudad, Estado".
# Se usa para reconocer que "Laff (WUOA) Birmingham, AL" es la misma cadena que "Laff" a secas.
US_AFFILIATE_RE = re.compile(r'^(?P<network>.+?)\s*\([A-Z]{3,5}\)\s*[A-Za-z .\-]+,\s*[A-Z]{2}\b')

# Redes con más afiliadas que esto (ABC/CBS/NBC/FOX/PBS tienen cientos, uno por mercado local)
# no se alias-ean: no tiene sentido ofrecer 200 mercados como "alternativas" de un canal
# nacional genérico. Solo aplica a cadenas de nicho con pocos feeds regionales (ej. Laff, Bounce).
MAX_AFFILIATES_FOR_ALIAS = 10


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
    # "tv"/"television" solo se quita si es la ÚLTIMA palabra (ej. "E! Entertainment
    # Television" -> "e entertainment", igual que la versión sin sufijo de otras fuentes).
    # No se filtra en cualquier posición como los demás SUFFIXES porque "tv" es parte del
    # nombre real de muchos canales cuando NO va al final (ej. "TV Land", "TV One").
    if tokens and tokens[-1] in ('tv', 'television'):
        tokens = tokens[:-1]
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
    """Arma el índice nombre -> channel_id de la fuente EPG de EE.UU. prioritaria (acidjesuz/US_guide),
    para que los canales ENGLISH matcheen ahí primero. merge_epgs.py ya descarga esa misma URL como
    parte de sus 75 fuentes y la deja cacheada en PRIORITY_EPG_CACHE_PATH — se reutiliza ese archivo
    en vez de descargarla de nuevo; si no está (ej. el usuario la comentó en epg_urls.json), se
    descarga acá como respaldo."""
    try:
        if os.path.exists(PRIORITY_EPG_CACHE_PATH):
            with open(PRIORITY_EPG_CACHE_PATH, 'rb') as f:
                data = f.read()
        else:
            data = download_epg(PRIORITY_EPG_URL, timeout=timeout)
        if not data:
            raise ValueError("sin datos")
        root = etree.fromstring(data)
    except Exception as e:
        print(f"⚠️  No se pudo obtener la fuente EPG prioritaria de EE.UU. ({e}); se usa solo el índice general")
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
    channel_country: channel_id -> código de país (o None)
    channel_region: channel_id -> feed regional detectado (East/West/Pacific/..., o None)
    name_to_ids: nombre_normalizado -> [channel_id, ...] (todas las coincidencias, en orden de
        aparición), global, para categorías sin país detectado
    name_to_ids_by_country: código_país -> {nombre_normalizado: [channel_id, ...]}
    """
    channels_by_id = {}
    channel_country = {}
    channel_region = {}
    name_to_ids = {}
    name_to_ids_by_country = {}
    affiliate_candidates = defaultdict(list)  # nombre_de_cadena_normalizado -> [channel_id, ...]

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
        channel_country[channel_id] = country
        channel_region[channel_id] = _detect_region_hint(channel_id, *display_names)

        for name_text in display_names:
            normalized = normalize_name(name_text)
            if not normalized:
                continue
            ids = name_to_ids.setdefault(normalized, [])
            if channel_id not in ids:
                ids.append(channel_id)
            if country:
                country_ids = name_to_ids_by_country.setdefault(country, {}).setdefault(normalized, [])
                if channel_id not in country_ids:
                    country_ids.append(channel_id)

            # "Laff (WUOA) Birmingham, AL HD" -> también es candidato de "laff", la cadena
            # a secas — pero solo se confirma como alias más abajo si la cadena tiene pocas
            # afiliadas (si no, sería ABC/CBS/NBC con cientos de mercados locales).
            affiliate_match = US_AFFILIATE_RE.match(name_text)
            if affiliate_match:
                network_key = normalize_name(affiliate_match.group('network'))
                if network_key:
                    affiliate_candidates[network_key].append(channel_id)

    # Solo se registra el alias de cadena para afiliadas de nicho (pocos mercados) — para las
    # grandes cadenas nacionales, cada afiliado es un mercado local distinto, no una
    # "alternativa" razonable del canal genérico.
    for network_key, cids in affiliate_candidates.items():
        unique_cids = list(dict.fromkeys(cids))
        if len(unique_cids) > MAX_AFFILIATES_FOR_ALIAS:
            continue
        for channel_id in unique_cids:
            ids = name_to_ids.setdefault(network_key, [])
            if channel_id not in ids:
                ids.append(channel_id)
            country = channel_country.get(channel_id)
            if country:
                country_ids = name_to_ids_by_country.setdefault(country, {}).setdefault(network_key, [])
                if channel_id not in country_ids:
                    country_ids.append(channel_id)

    return channels_by_id, channel_country, channel_region, name_to_ids, name_to_ids_by_country


def match_channel(xtream_name, overrides, name_to_ids, name_to_ids_by_country, country_code, priority_index=None):
    """Devuelve (channel_id_elegido, [todos_los_candidatos]). El elegido es siempre el primero
    de la lista; el resto son otras coincidencias válidas para el mismo nombre, por si el
    matcheo automático no fue el correcto (ej. otro país o otro feed regional)."""
    if xtream_name in overrides:
        return overrides[xtream_name], [overrides[xtream_name]]

    normalized = normalize_name(xtream_name)
    # Candidatos a probar en orden: el nombre tal cual y, si termina en " 1" (ej. "espn 1"),
    # también sin el número — muchas fuentes EPG listan el canal principal sin numerar.
    name_candidates = [normalized]
    if normalized.endswith(' 1'):
        name_candidates.append(normalized[:-2])

    if priority_index:
        for candidate in name_candidates:
            if candidate in priority_index:
                return priority_index[candidate], [priority_index[candidate]]

    if country_code and country_code in name_to_ids_by_country:
        # Hay canales indexados para ese país: matchea solo contra ellos, para no
        # confundir p.ej. "Canal 26" de Argentina con uno homónimo de Chile.
        country_index = name_to_ids_by_country[country_code]
        for candidate in name_candidates:
            ids = country_index.get(candidate)
            if ids:
                return ids[0], ids
        return None, []

    # Sin país detectado, o sin ningún canal de ese país en el EPG (cobertura cero):
    # el índice global es la única opción disponible.
    for candidate in name_candidates:
        ids = name_to_ids.get(candidate)
        if ids:
            return ids[0], ids
    return None, []


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

    channels_by_id, channel_country, channel_region, name_to_ids, name_to_ids_by_country = build_epg_index(epg_root)

    # Igual que con epg_channel_id más abajo: un override que apunte a un channel_id que no
    # existe en el EPG sería un tvg-id colgado, así que se valida antes de confiar en él.
    overrides_raw = load_channel_map()
    invalid_overrides = [name for name, cid in overrides_raw.items() if cid not in channels_by_id]
    if invalid_overrides:
        preview = ', '.join(invalid_overrides[:5])
        print(f"⚠️  {len(invalid_overrides)} override(s) en {CHANNEL_MAP_PATH} apuntan a un channel_id inexistente en el EPG, se ignoran: {preview}")
    overrides = {name: cid for name, cid in overrides_raw.items() if cid in channels_by_id}

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

    matched_ids = set()  # todos los channel_id que quedan en my_epg.xml.gz (principal + alternativas)
    matched_stream_count = 0  # cuántos canales de Xtream encontraron al menos un match (para las stats)
    channel_display_labels = {}  # channel_id -> etiqueta a anotar en su display-name en my_epg.xml.gz
    unmatched = []
    entries = []  # (section_order, category_order, index_original, líneas m3u)
    section_order = {name: i for i, name in enumerate(section_display_order)}
    no_section_order = len(section_display_order)  # categorías sin sección van al final
    category_first_seen = {}

    # classify_section/is_divider_category/flag_to_country_code solo dependen de `category`
    # (~99 valores únicos), no de cada canal (~3000+) — se calculan una vez por categoría.
    category_info_cache = {}

    def category_info(category):
        info = category_info_cache.get(category)
        if info is None:
            info = (
                classify_section(category, section_rules),
                is_divider_category(category),
                flag_to_country_code(category),
            )
            category_info_cache[category] = info
        return info

    for i, stream in enumerate(live_streams):
        category = categories.get(str(stream.get('category_id')), 'General')
        name = stream.get('name', '')
        stream_id = stream.get('stream_id')
        container_ext = stream.get('container_extension', 'm3u8')
        section, category_is_divider, category_country_code = category_info(category)

        if section == PRIORITY_SECTION:
            # Toda la sección ENGLISH es contenido de EE.UU. por definición, aunque el nombre
            # del canal no diga "USA" explícitamente (ej. "Movie Channels").
            country_code = 'us'
            priority_index = priority_us_index
        else:
            # Prioridad: país detectado en el propio nombre del canal (más específico, ej. "ESPN 1
            # ARG" dentro de la categoría genérica "ESPN") y si no hay, el de la bandera de la categoría.
            country_code = detect_country(name) or category_country_code
            priority_index = None

        channel_id, candidates = match_channel(
            name, overrides, name_to_ids, name_to_ids_by_country, country_code, priority_index,
        )
        if not channel_id:
            # Xtream trae su propio "epg_channel_id" (una adivinanza del proveedor, sin
            # verificar). Solo sirve si de verdad existe en nuestro EPG con datos reales —
            # si no, sería un tvg-id colgado que no aparece en my_epg.xml.gz.
            candidate = stream.get('epg_channel_id')
            if candidate and candidate in channels_by_id:
                channel_id = candidate
                candidates = [candidate]

        if category_is_divider and section:
            # Separador mapeado a una sección conocida: va primero, como encabezado.
            cat_order = -1
        else:
            cat_order = category_first_seen.setdefault(category, len(category_first_seen))

        stream_url = build_stream_url(active_server, username, password, stream_id, container_ext)

        if channel_id:
            matched_ids.add(channel_id)
            matched_stream_count += 1
            logo = channels_by_id.get(channel_id) or stream.get('stream_icon', '')

            # Cuando hay más de un candidato posible, todos (el elegido + hasta
            # MAX_ALT_ENTRIES alternativas) quedan en my_epg.xml.gz con su display-name
            # anotado (país/región/id) — no como entradas extra acá en el M3U, sino para que
            # se puedan buscar y elegir a mano con la función "Seleccionar EPG" del
            # reproductor, que busca en toda la guía cargada. Si no hay ambigüedad, se deja
            # el display-name original tal cual (sin agregar ruido a canales ya resueltos bien).
            shown_ids = [channel_id] + candidates[1:1 + MAX_ALT_ENTRIES]
            if len(shown_ids) > 1:
                for shown_id, label in _labeled_candidates(shown_ids, channel_country, channel_region):
                    matched_ids.add(shown_id)
                    channel_display_labels[shown_id] = label

            entries.append((
                section_order.get(section, no_section_order),
                cat_order,
                i,
                f'#EXTINF:-1 tvg-id="{_m3u_attr(channel_id)}" tvg-name="{_m3u_attr(name)}" '
                f'tvg-logo="{_m3u_attr(logo)}" group-title="{_m3u_attr(category)}",{_m3u_attr(name)}\n{stream_url}',
            ))
        else:
            unmatched.append(name)
            entries.append((
                section_order.get(section, no_section_order),
                cat_order,
                i,
                f'#EXTINF:-1 tvg-id="{_m3u_attr(name)}" tvg-name="{_m3u_attr(name)}" '
                f'tvg-logo="{_m3u_attr(stream.get("stream_icon", ""))}" group-title="{_m3u_attr(category)}",{_m3u_attr(name)}\n{stream_url}',
            ))

    entries.sort(key=lambda e: (e[0], e[1], e[2]))

    playlist_lines = ['#EXTM3U'] + [e[3] for e in entries]
    with open(PLAYLIST_PATH, 'w', encoding='utf-8') as f:
        f.write('\n'.join(playlist_lines) + '\n')

    filtered_root = etree.Element('tv', attrib=dict(epg_root.attrib))
    for channel in epg_root.findall('channel'):
        channel_id = channel.get('id')
        if channel_id not in matched_ids:
            continue
        label = channel_display_labels.get(channel_id)
        if label:
            # Se anota el país/región/id en el propio display-name del canal (no en el M3U):
            # así se ve al buscar manualmente con "Seleccionar EPG" en el reproductor, que
            # busca sobre toda la guía cargada, sin depender de que el M3U tenga duplicados.
            # Va al PRINCIPIO del texto (no al final) para que no quede cortado si la fila
            # del reproductor trunca nombres largos por el lado derecho.
            first_display_name = channel.find('display-name')
            if first_display_name is not None:
                first_display_name.text = f"[{label}] {first_display_name.text or ''}".strip()
        filtered_root.append(channel)
    for programme in epg_root.findall('programme'):
        if programme.get('channel') in matched_ids:
            filtered_root.append(programme)

    body = etree.tostring(filtered_root, encoding='utf-8', xml_declaration=False, pretty_print=True)
    output = b'<?xml version="1.0" encoding="UTF-8" ?>\n' + body
    with gzip.open(FILTERED_EPG_PATH, 'wb') as f:
        f.write(output)

    print(f"\n📊 Canales de Xtream: {len(live_streams)}")
    print(f"   Con EPG matcheado: {matched_stream_count}")
    print(f"   Sin EPG (revisar xtream_channel_map.json si aplica): {len(unmatched)}")
    if unmatched:
        preview = ', '.join(unmatched[:15])
        print(f"   Ejemplos sin match: {preview}")
    if len(matched_ids) > matched_stream_count:
        print(f"   Alternativas de EPG agregadas a {FILTERED_EPG_PATH} (usá \"Seleccionar EPG\" en tu reproductor para elegir manualmente): {len(matched_ids) - matched_stream_count}")
    print(f"✅ {PLAYLIST_PATH} y {FILTERED_EPG_PATH} generados")


if __name__ == '__main__':
    generate()
