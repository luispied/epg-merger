#!/usr/bin/env python3
"""Genera, por cada perfil configurado, su playlist y su EPG acotado.

Cruza la lista real de canales de Xtream Codes con el EPG ya fusionado por merge_epgs.py.
`merged.xml.gz` se lee **en streaming** y en dos pasadas, sin cargar nunca el árbol entero
(~1,3 GB de XML y ~2 millones de programas: en memoria pasaba los 10 GB y en un runner cargado
la corrida se arrastraba por swap): primero solo los <channel>, para indexar y matchear todos
los perfiles; después los <programme> de a uno, que van a la programación de la interfaz y a
la guía de cada perfil a medida que pasan.
"""
import contextlib
import copy
import datetime
import gzip
import hashlib
import json
import os
import re
import time
import unicodedata

from lxml import etree

from channel_db import load_channel_db
from channel_names import flag_to_country_code, parse_channel_name, strip_accents, strip_display_prefix
from epg_index import MIN_SCORE, PLAUSIBLE_MIN, EpgIndex, joined_variant
from merge_epgs import load_sources
from profiles import OUTPUT_DIR, load_profiles
from providers import M3UProvider, ProviderError, XtreamProvider
from xtream_client import get_live_categories, get_live_streams

MERGED_EPG_PATH = 'merged.xml.gz'
CHANNEL_MAP_PATH = 'xtream_channel_map.json'
SECTIONS_CONFIG_PATH = 'playlist_sections.json'
EPG_CATALOG_PATH = os.path.join('out', 'epg_catalog.json')
EPG_ICONS_PATH = os.path.join('out', 'epg_icons.json')
SCHEDULE_DIR = os.path.join('out', 'schedule')

# Ventana de programación que se publica por canal, para que la interfaz de corrección (docs/)
# pueda mostrar qué está dando cada candidato al elegir el EPG de un canal. El navegador calcula
# "en el aire ahora mismo" comparando estos horarios contra su propio reloj (no se congela un
# "ahora" al momento de esta corrida), así que sigue siendo preciso aunque se mire horas después.
SCHEDULE_WINDOW_PAST = datetime.timedelta(hours=1)
SCHEDULE_WINDOW_FUTURE = datetime.timedelta(hours=30)
SCHEDULE_MAX_ENTRIES = 60  # tope por canal, por si alguna fuente trae franjas muy cortas
# Tope de largo de la descripción de cada programa (la mediana ronda los 120 caracteres y el
# p90 los 240): alguna fuente trae sinopsis larguísimas que solo inflarían los archivos.
SCHEDULE_DESC_MAX = 400
# Además del archivo por canal, un índice por hora UTC (schedule/hour/<AAAAMMDDHH>.json) con lo
# que da TODO el catálogo en esa hora: el buscador de la interfaz baja uno solo (el de la hora
# actual) y con eso muestra qué está dando cada resultado y permite buscar por programa.
SCHEDULE_HOUR_SUBDIR = 'hour'

_XMLTV_TIME_RE = re.compile(r'^(\d{14})\s*(?:([+-]\d{4}))?$')

# Cuántos candidatos alternativos incluir (con display-name anotado) en el EPG del perfil
# cuando un canal tiene varios EPG posibles (ej. "E!" existe para 17 países/feeds distintos) —
# sin este tope, un solo canal ambiguo podría inflar el EPG con decenas de candidatos.
MAX_ALT_ENTRIES = 4


# --------------------------------------------------------------------- categorías y secciones

# Reglas propias de cada proveedor (provider_rules.json). Sin ese archivo el pipeline es
# genérico: no hay categorías "separador", las categorías sin sección van en el orden en que las
# lista el proveedor y nada se trata como evento suelto ni como "no necesita EPG". El archivo de
# este repo trae las reglas del proveedor actual (separadores "▆▆▆ＰＰＶ　ＥＶＥＮＴＳ▆▆▆", etc.).
PROVIDER_RULES_PATH = 'provider_rules.json'

DEFAULT_PROVIDER_RULES = {
    # 'provider' (orden del proveedor) o 'alphabetical', para las categorías sin orden explícito.
    'category_order': 'provider',
    # Categorías decorativas que el proveedor usa como separador visual en su panel: se
    # conservan pero se reubican como encabezado al principio de la sección que les corresponde.
    'dividers': {'pattern': None, 'sections': {}, 'display_names': {}},
    # Secciones de eventos sueltos (PPV) que ningún EPG público cubre: la interfaz no las muestra
    # para corregir, salvo las categorías listadas en editable_categories.
    'event_sections': {'sections': [], 'editable_categories': []},
    # Lo que no necesita guía por naturaleza: no cuenta en "A revisar" ni "Sin EPG".
    'no_epg': {'categories': [], 'sections': [], 'category_patterns': []},
    # Puntaje mínimo para asignar una guía automáticamente. Medido con el banco de prueba
    # (tools/match_benchmark.py): por debajo de 0.7 acierta ~20 % (una guía equivocada es peor
    # que ninguna), entre 0.7 y 0.8 ~72 %, desde 0.8 ~98 %. Lo que queda debajo no se asigna
    # pero sigue como sugerencia en "A revisar".
    'min_assign_score': 0.7,
    # Señal horaria preferida de los canales de EE.UU./Canadá cuando el nombre no dice cuál:
    # 'east', 'pacific' (= 'west'), 'mountain', 'central' o null (sin preferencia).
    'preferred_feed': 'east',
}


def _divider_key(category):
    """'▆▆▆ＤＥＰＯＲＴＥＳ ▆▆▆' -> 'deportes' (des-fullwidth + solo alfanumérico)."""
    text = unicodedata.normalize('NFKC', category)
    text = strip_accents(text).lower()
    return re.sub(r'[^a-z0-9]', '', text)


def load_provider_rules(path=None):
    """provider_rules.json mezclado sobre los valores genéricos (lo que no declara, queda genérico)."""
    path = path or PROVIDER_RULES_PATH
    rules = json.loads(json.dumps(DEFAULT_PROVIDER_RULES))
    try:
        with open(path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    except FileNotFoundError:
        return rules
    except json.JSONDecodeError as e:
        print(f"⚠️  {path} inválido ({e}); se usan reglas genéricas")
        return rules
    for key, value in raw.items():
        if key.startswith('_'):
            continue
        if isinstance(value, dict) and isinstance(rules.get(key), dict):
            rules[key].update(value)
        else:
            rules[key] = value
    return rules


class _Rules:
    """Reglas vigentes, ya compiladas (las fija set_provider_rules; generate() las carga)."""

    def __init__(self, rules):
        self.raw = rules
        pattern = rules['dividers'].get('pattern')
        self.divider_re = re.compile(pattern) if pattern else None
        self.divider_sections = {_divider_key(k): v for k, v in (rules['dividers'].get('sections') or {}).items()}
        self.divider_display = dict(rules['dividers'].get('display_names') or {})
        self.alphabetical = rules.get('category_order') == 'alphabetical'
        self.min_assign_score = float(rules.get('min_assign_score') or MIN_SCORE)
        self.preferred_feed = (rules.get('preferred_feed') or '').lower() or None
        no_epg = rules.get('no_epg') or {}
        self.no_epg_categories = set(no_epg.get('categories') or [])
        self.no_epg_sections = set(no_epg.get('sections') or [])
        self.no_epg_patterns = [re.compile(p) for p in no_epg.get('category_patterns') or []]

    def needs_no_epg(self, category, section):
        """Categoría que no necesita guía según las reglas del proveedor (General, 24/7…)."""
        return (category in self.no_epg_categories or (section or '') in self.no_epg_sections
                or any(p.search(category) for p in self.no_epg_patterns))


_rules = _Rules(DEFAULT_PROVIDER_RULES)


def set_provider_rules(rules):
    global _rules
    _rules = _Rules(rules)


def is_divider_category(category):
    return bool(_rules.divider_re and _rules.divider_re.search(category))


def _strip_category_label(category):
    """Quita emoji/símbolos iniciales para comparar el texto: '🏈 ESPN' -> 'espn'."""
    text = strip_accents(category).lower()
    text = re.sub(r'^[^a-z0-9]+', '', text)
    return text.strip()


def _ordered_names(raw):
    """Acepta una lista (la posición es el orden) o un objeto {"nombre": número} (menor número
    va primero) y devuelve siempre la lista de nombres ya ordenada."""
    if isinstance(raw, dict):
        return [name for name, _ in sorted(raw.items(), key=lambda kv: kv[1])]
    return list(raw)


def load_sections_config(path=SECTIONS_CONFIG_PATH):
    """Devuelve (orden_de_secciones, matchers, config_epg_por_seccion, orden_de_categorias)."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"⚠️  No se pudo leer {path} ({e}); no se agruparán categorías en secciones")
        return [], [], {}, {}

    matchers, section_epg, category_order = [], {}, {}
    for rule in config.get('rules', []):
        section = rule['section']
        matchers.append((section, _make_rule_matcher(rule)))
        # Si varias reglas apuntan a la misma sección, manda la primera que declare 'epg'.
        if 'epg' in rule and section not in section_epg:
            section_epg[section] = rule['epg']
        if 'category_order' in rule and section not in category_order:
            raw_order = rule['category_order']
            # Formato nuevo: {"nombre categoría": número}, para reordenar cambiando un número
            # en vez de mover líneas. El formato viejo (lista, la posición es el orden) se
            # sigue aceptando. Se ignora el emoji/acentos/mayúsculas al comparar, igual que las
            # reglas de matcheo: así "🏈 ESPN" y "⚽️ ESPN" caen en la misma posición.
            if isinstance(raw_order, dict):
                category_order[section] = {
                    _strip_category_label(cat): pos for cat, pos in raw_order.items()
                }
            else:
                category_order[section] = {
                    _strip_category_label(cat): i for i, cat in enumerate(raw_order)
                }
    # Preferencias por categoría (más finas que las de la sección): {"ESPN": {"prefer_sources":
    # [...]}}. Van en el mismo dict con una clave aparte; ver epg_config_for.
    for cat, cfg in (config.get('category_epg') or {}).items():
        if isinstance(cfg, dict):
            section_epg[(CATEGORY_EPG_KEY, _strip_category_label(cat))] = cfg
    return _ordered_names(config.get('order', [])), matchers, section_epg, category_order


CATEGORY_EPG_KEY = 'category'


def epg_config_for(section, category, section_epg):
    """Config de EPG de un canal: la de su sección, más la de su categoría si hay una (sus
    fuentes preferidas van primero y su país manda)."""
    base = section_epg.get(section) or {}
    extra = section_epg.get((CATEGORY_EPG_KEY, _strip_category_label(category or ''))) if category else None
    if not extra:
        return base
    merged = {**base, **extra}
    merged['prefer_sources'] = list(dict.fromkeys(
        list(extra.get('prefer_sources') or []) + list(base.get('prefer_sources') or [])))
    return merged


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
        return _rules.divider_sections.get(_divider_key(category))  # None si no está mapeado (ej. ADULTS)

    label = _strip_category_label(category)
    for section_name, matcher in section_rules:
        if matcher(category, label):
            return section_name
    return None  # sin sección: se agrupan al final, en orden de aparición original


# ------------------------------------------------------------------ etiquetas de alternativas

def _shorten_id(text, max_len=24):
    """Recorta un identificador largo sin partirlo a la mitad de una palabra."""
    if len(text) <= max_len:
        return text
    cut = text[:max_len]
    last_sep = max(cut.rfind('.'), cut.rfind(' '))
    if last_sep > 8:  # no cortar tan corto que la etiqueta quede sin info útil
        cut = cut[:last_sep]
    return cut + '…'


def _epg_source_label(channel_id, index):
    """De dónde salió el EPG asignado, para mostrar entre corchetes: país + feed regional si se
    detectaron (ej. "US East" vs "US Pacific"), y si no, el id de la fuente — que ahora viaja
    en el propio canal, en vez de tener que adivinarlo desde el channel_id."""
    country = index.country.get(channel_id)
    region = index.region.get(channel_id)
    if country and region:
        return f"{country.upper()} {region.capitalize()}"
    if country:
        return country.upper()
    if region:
        return region.capitalize()
    return _shorten_id(index.source.get(channel_id) or channel_id)


def _labeled_candidates(channel_ids, index):
    """Etiqueta cada channel_id; si dos quedan con la misma etiqueta (ej. dos ".us" sin feed
    regional detectado), se les agrega un fragmento distintivo para que sigan siendo
    distinguibles — preferentemente del nombre del canal, y si no, del channel_id crudo."""
    labels = [_epg_source_label(cid, index) for cid in channel_ids]
    repeated = {label for label in labels if labels.count(label) > 1}
    result = []
    for cid, label in zip(channel_ids, labels):
        if label in repeated:
            hint = index.display_name.get(cid) or cid
            label = f"{label} · {_shorten_id(hint, 20)}"
        result.append((cid, label))
    return result


# ------------------------------------------------------------------------------------ salida

def _m3u_attr(value):
    """Sanitiza un valor para un atributo M3U entre comillas dobles. El formato M3U no tiene
    mecanismo de escape estándar, así que un '"' literal rompería el parseo del reproductor."""
    return (value or '').replace('"', "'").replace('\n', ' ').replace('\r', ' ')


# Confirmado con TiviMate: una categoría del proveedor que trae '/' en el nombre (normal o de
# ancho completo '／', como el separador "▆▆▆２４／７▆▆▆") no se muestra en absoluto — varios
# reproductores tratan '/' en group-title como separador de subcategorías anidadas.
GROUP_TITLE_SLASH_RE = re.compile(r'[/／∕⁄]')


def _safe_group_title(category):
    return GROUP_TITLE_SLASH_RE.sub('-', category)


def load_channel_map(path=CHANNEL_MAP_PATH):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f).get('overrides', {})
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def load_channel_edits(path=CHANNEL_MAP_PATH):
    """(renames, category_moves, hidden, hidden_categories) de xtream_channel_map.json,
    armables desde la interfaz de corrección: {nombre_crudo_en_xtream: nombre_a_mostrar},
    {nombre_crudo: categoría}, {nombre_crudo: true} para sacarlo de la playlist y
    {categoría: true} para sacar una categoría entera. Igual que los overrides de EPG, van por
    el nombre CRUDO de Xtream, así que renombrar un canal no rompe su override."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}, {}, set(), set()
    renames = {k: v.strip() for k, v in (data.get('renames') or {}).items()
               if isinstance(v, str) and v.strip()}
    moves = {k: v for k, v in (data.get('categories') or {}).items()
             if isinstance(v, str) and v and not is_divider_category(v)}
    hidden = {k for k, v in (data.get('hidden') or {}).items() if v}
    hidden_categories = {k for k, v in (data.get('hidden_categories') or {}).items() if v}
    return renames, moves, hidden, hidden_categories


def match_channel(name, parsed, index, overrides, epg_config, fallback_country):
    """Devuelve (channel_id_elegido, motivo, puntaje, [candidatos_rankeados]).

    El elegido es siempre el primero de la lista; el resto son otras coincidencias posibles,
    ya ordenadas por confianza, por si el matcheo automático no fue el correcto.
    """
    if name in overrides:
        return overrides[name], 'override', 1.0, []

    country = epg_config.get('country') or parsed.country or fallback_country
    ranked = index.rank(
        parsed,
        prefer_sources=epg_config.get('prefer_sources', ()),
        country=country,
    )
    if ranked and calibrated_score(ranked[0]) >= _rules.min_assign_score:
        best = ranked[0]
        return best.channel_id, best.reason, calibrated_score(best), ranked
    return None, None, 0.0, ranked


# "Bien" (≥ 0.8) tiene que querer decir que el nombre coincide, no que el país ayudó: el
# refuerzo por país o fuente preferida sirve para ELEGIR entre candidatos, pero un nombre que
# coincide a medias ("RTL 102.5 Disco" vs "RTL 102.5", "Canal 21 TV" vs "Canal Orbe 21") queda
# debajo del umbral genérico de asignación (0.7): en el banco de prueba esos casos casi
# siempre eran otro canal. Con un umbral más bajo (el de Luis, 0.45) se asignan como "Dudoso".
GOOD_NAME_BASE = 0.75
GOOD_SCORE = 0.8
PARTIAL_NAME_CAP = 0.69


def calibrated_score(candidate):
    if candidate.name_score < GOOD_NAME_BASE and candidate.score > PARTIAL_NAME_CAP:
        return PARTIAL_NAME_CAP
    return candidate.score


# El id de EPG del proveedor gana sobre un match por nombre de menos de este puntaje ("Bien"
# en la interfaz es 0.8), y si además el nombre coincide bastante, queda como "Bien".
TVG_ID_OVERRIDES_BELOW = 0.8
TVG_ID_STRONG_NAME = 0.5
TVG_ID_SCORE = 0.85

# "Clan.es@SD", "Telefe.ar": el sufijo de país del id de EPG que trae la lista.
_TVG_ID_COUNTRY_RE = re.compile(r'\.([a-z]{2})(?:@[^.]*)?$', re.IGNORECASE)


def tvg_id_country(epg_channel_id, rules=None):
    """País que dice el id de EPG del proveedor, como pista cuando el nombre y la categoría no
    lo dicen (las listas de iptv-org no traen banderas ni prefijos "AR|")."""
    m = _TVG_ID_COUNTRY_RE.search(epg_channel_id or '')
    if not m:
        return None
    code = m.group(1).lower()
    aliases = rules.country_code_aliases if rules else {}
    return aliases.get(code, code)


# Diccionario de canales de iptv-org (channel_db.py), si está: último recurso para los canales
# que no encontraron guía por su nombre. Lo fija generate() (y el banco de prueba).
_channel_db = None


def set_channel_db(db):
    global _channel_db
    _channel_db = db


def _match_by_alias(raw_name, channel_name, list_id, index, overrides, epg_config, country, ranked):
    """Prueba con los otros nombres del canal según el diccionario ("13C" es "Canal 13 Cable",
    "LN+" es "La Nación +"). Solo acepta un resultado "Bien" y del mismo país que dice el
    diccionario: en el banco de prueba, con menos que eso se colaban canales de otro país."""
    for alias, alias_country in _channel_db.aliases(channel_name, list_id, country):
        parsed = parse_channel_name(alias, index.rules)
        cid, _, score, alt_ranked = match_channel(raw_name, parsed, index, overrides, epg_config,
                                                  country or alias_country)
        if not cid or score < GOOD_SCORE:
            continue
        # País confirmado de los dos lados: una guía sin país (fuentes multi-país) mandaba
        # "FOX Sports 1 CL" a la de EE.UU.
        cand_country = index.country.get(cid)
        if not alias_country or not cand_country or not index.rules.country_matches(alias_country, cand_country):
            continue
        return cid, 'alias', score, alt_ranked
    return None, None, 0.0, ranked


def match_stream(raw_name, epg_channel_id, index, overrides, epg_config, category_country,
                 trust_list_ids=True):
    """EPG de un canal del proveedor: (nombre_limpio, channel_id, motivo, puntaje, ranking).

    Es todo el matching automático de un canal, en un solo lugar para que la corrida y el banco
    de prueba (tools/match_benchmark.py) usen exactamente el mismo código.

    `trust_list_ids`: confiar en el id de EPG del proveedor como pista de país y para ganarle a
    un match por nombre dudoso. Sirve en listas M3U (el `tvg-id` de iptv-org dice el país real
    del canal), pero NO en Xtream: ahí el `epg_channel_id` es una adivinanza del proveedor (el
    de Luis pone ".mx" a canales panregionales y con la pista cambiaban 300 canales de la guía
    argentina a la mexicana). En Xtream ese id solo se usa si el nombre no encontró nada.
    """
    # Se saca el prefijo que antepone el proveedor (código de país, número de evento) del
    # nombre que se muestra y del que se matchea — pero los overrides de
    # xtream_channel_map.json siguen buscándose por el nombre CRUDO, tal como aparece en
    # Xtream, que es lo que la persona que configura el override tiene copiado del panel.
    channel_name, prefix_country = strip_display_prefix(raw_name, index.rules)
    parsed = parse_channel_name(channel_name, index.rules)
    fallback_country = (prefix_country or category_country
                        or (tvg_id_country(epg_channel_id, index.rules) if trust_list_ids else None))
    channel_id, reason, score, ranked = match_channel(
        raw_name, parsed, index, overrides, epg_config, fallback_country,
    )
    # Si no quedó "Bien", probar con las palabras pegadas ("RTL Zwei" -> "rtlzwei", que es como
    # otra fuente escribe el canal) y quedarse con lo mejor.
    joined = joined_variant(parsed)
    if joined and reason != 'override' and score < GOOD_SCORE:
        alt = match_channel(raw_name, joined, index, overrides, epg_config, fallback_country)
        if alt[0] and alt[2] > score:
            channel_id, reason, score, ranked = alt
            parsed = joined

    # El proveedor trae su propio id de EPG (Xtream: "epg_channel_id"; M3U: "tvg-id"), que es
    # una adivinanza sin verificar: a veces es el mismo id "por defecto" para una docena de
    # canales sin relación entre sí. Solo se usa si el canal apuntado existe en nuestra guía
    # (exacto o con el "@SD" de iptv-org de más) y su nombre real tiene algo que ver con el del
    # canal. En ese caso gana sobre un match por nombre dudoso: un id que coincide y un nombre
    # que cierra son más evidencia que un nombre parecido solo.
    if not channel_id and _channel_db is not None:
        channel_id, reason, score, ranked = _match_by_alias(
            raw_name, channel_name, epg_channel_id if trust_list_ids else None,
            index, overrides, epg_config, parsed.country or fallback_country, ranked,
        )

    candidate = index.resolve_id(epg_channel_id)
    beats = score < TVG_ID_OVERRIDES_BELOW if trust_list_ids else not channel_id
    if candidate and candidate != channel_id and reason != 'override' and beats:
        plausibility = max(index.best_name_score(p, candidate) for p in filter(None, (parsed, joined_variant(parsed))))
        if plausibility >= PLAUSIBLE_MIN:
            channel_id, reason = candidate, 'xtream_epg_id'
            score = plausibility
            if trust_list_ids and plausibility >= TVG_ID_STRONG_NAME:
                score = max(plausibility, TVG_ID_SCORE)
    return channel_name, channel_id, reason, score, ranked


def load_provider_channels(profile):
    """Canales del proveedor del perfil (ver providers.py). Las funciones de Xtream se buscan
    en este módulo al llamar, así los tests pueden reemplazarlas."""
    if profile.get('type') == 'm3u':
        return M3UProvider(profile).load()
    return XtreamProvider(
        profile,
        get_streams=lambda *a, **kw: get_live_streams(*a, **kw),
        get_categories=lambda *a, **kw: get_live_categories(*a, **kw),
    ).load()


def load_no_epg_categories(path=CHANNEL_MAP_PATH):
    """Categorías marcadas "Sin guía" en la interfaz (no_epg_categories de
    xtream_channel_map.json): no cambian la playlist, solo se exportan a Grilla web."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return set()
    return {k for k, v in (data.get('no_epg_categories') or {}).items() if v}


def generate_for_profile(profile, index, channels_root, sections, overrides, edits=({}, {}, set(), set()),
                         no_epg_categories=frozenset()):
    """Genera playlist y reporte de matching para un perfil. Devuelve un ProfileEpg con lo que
    necesita su guía acotada (se escribe después, en la pasada de programas: ver generate()),
    o None si no se pudo leer el proveedor. `channels_root`: los <channel> de la guía.

    `edits` = (renames, category_moves, hidden, hidden_categories), ver load_channel_edits."""
    renames, category_moves, hidden, hidden_categories = edits
    hidden_count = 0
    section_display_order, section_rules, section_epg, category_order = sections
    name = profile['name']

    print(f"\n{'=' * 60}\n👤 Perfil: {name}")
    try:
        live_streams = load_provider_channels(profile)
    except ProviderError as e:
        print(f"❌ {e}")
        return None

    matched_ids = set()        # channel_id que quedan en el EPG del perfil (elegido + alternativas)
    matched_stream_count = 0
    channel_display_labels = {}
    unmatched = []
    entries = []               # (orden_seccion, orden_categoria, indice_original, líneas m3u)
    report = []
    # Lo mismo, para importarlo en Grilla web (ver write_web_import).
    web_channels = {}
    web_groups = []            # (orden_seccion, orden_categoria, indice, grupo)
    web_hidden_groups = set()
    web_no_epg_groups = set()
    web_epg_config = {}        # categoría cruda → preferencias de EPG (país, fuentes)

    section_order = {s: i for i, s in enumerate(section_display_order)}
    no_section_order = len(section_display_order)  # categorías sin sección van al final

    # classify_section/is_divider_category/flag_to_country_code solo dependen de `category`
    # (~99 valores únicos), no de cada canal (~3000+): se calculan una vez por categoría.
    category_info_cache = {}
    # Orden en que el proveedor lista cada categoría (para category_order: 'provider').
    provider_pos = {}
    for stream in live_streams:
        provider_pos.setdefault(stream['category'], len(provider_pos))

    def category_info(category):
        info = category_info_cache.get(category)
        if info is None:
            section = classify_section(category, section_rules)
            is_divider = is_divider_category(category)
            # Una categoría divisor con sección mapeada va primero como encabezado (0,).
            # Si la sección declaró 'category_order', se respeta esa posición exacta (1, i).
            # Una categoría nueva del proveedor que no esté en esa lista, o si la sección no
            # declaró orden, va al final de las listadas: alfabéticamente o en el orden del
            # proveedor, según provider_rules.json.
            explicit_pos = category_order.get(section, {}).get(_strip_category_label(category))
            if is_divider and section:
                sort_key = (0,)
            elif explicit_pos is not None:
                sort_key = (1, explicit_pos)
            elif _rules.alphabetical:
                sort_key = (2, _strip_category_label(category))
            else:
                sort_key = (2, provider_pos.get(category, len(provider_pos)))
            display_category = _rules.divider_display.get(section, category) if is_divider else category
            info = (
                section,
                is_divider,
                flag_to_country_code(category),
                epg_config_for(section, category, section_epg),
                sort_key,
                display_category,
            )
            category_info_cache[category] = info
        return info

    for i, stream in enumerate(live_streams):
        category = stream['category']
        raw_name = stream['name']
        section, category_is_divider, category_country, epg_config, cat_order, display_category = category_info(category)
        if epg_config and not category_is_divider:
            web_epg_config.setdefault(category, epg_config)

        # Canal movido de categoría a mano desde la interfaz: solo cambia DÓNDE aparece en la
        # playlist (sección, orden, group-title). El matching de EPG sigue usando la categoría
        # original (país, fuentes preferidas), para que moverlo no le cambie el EPG sin avisar.
        moved_to = None if category_is_divider else category_moves.get(raw_name)
        if moved_to and moved_to != category:
            section, _, _, _, cat_order, display_category = category_info(moved_to)
        else:
            moved_to = None

        # Un override en `null` (armable desde la interfaz de corrección, botón "Forzar sin
        # EPG") significa "nunca le asignes EPG a este canal, ni de casualidad": sin esto, un
        # canal así de todos modos entraría al matching automático y al fallback de
        # "epg_channel_id" de abajo, así que la próxima corrida se lo podría volver a asignar.
        forced_no_epg = raw_name in overrides and overrides[raw_name] is None

        if category_is_divider:
            # El placeholder que el proveedor usa como separador visual ("== 24 /7 Only ==")
            # no es un canal real: matchearlo contra el EPG solo arriesga un falso positivo de
            # bajo puntaje que termine compartiendo tvg-id con un canal real (pasó con "COCINA
            # 24/7", que un match débil por los tokens "24"/"7" mandó al mismo channel_id que
            # este separador — y varios reproductores, TiviMate confirmado, esconden uno de los
            # dos cuando dos entradas comparten tvg-id).
            channel_name = strip_display_prefix(raw_name, index.rules)[0]
            channel_id, reason, score, ranked = None, None, 0.0, []
        elif forced_no_epg:
            channel_name = strip_display_prefix(raw_name, index.rules)[0]
            channel_id, reason, score, ranked = None, 'override_none', 1.0, []
        else:
            channel_name, channel_id, reason, score, ranked = match_stream(
                raw_name, stream['epg_channel_id'], index, overrides, epg_config, category_country,
                trust_list_ids=profile.get('type') == 'm3u',
            )

        stream_url = stream['url']
        alternatives = [
            c for c in ranked
            if c.channel_id != channel_id and c.score >= PLAUSIBLE_MIN
        ][:MAX_ALT_ENTRIES]

        # El reporte no lleva URLs de stream: se publica/diffea sin credenciales adentro.
        report.append({
            'xtream_name': raw_name,
            'category': category,
            # El id de EPG que sugiere el proveedor (no lleva credenciales): con él el banco de
            # prueba simula exactamente la corrida (tools/match_benchmark.py).
            'provider_epg_id': stream['epg_channel_id'],
            'section': category_info(category)[0],
            'chosen': channel_id,
            'reason': reason,
            'score': round(score, 4),
            'alternatives': [
                {'channel_id': c.channel_id, 'score': round(c.score, 4),
                 'source': index.source.get(c.channel_id)}
                for c in alternatives
            ],
        })

        # Grilla web agrupa por la categoría del proveedor (o la movida a mano); los separadores
        # llevan como grupo y nombre el título de su sección, igual que en esta playlist.
        web_group = display_category if category_is_divider else (moved_to or category)
        web_groups.append((section_order.get(section, no_section_order), cat_order, i, web_group))
        if (moved_to or category) in hidden_categories:
            web_hidden_groups.add(web_group)
        if not category_is_divider and (web_group in no_epg_categories or _rules.needs_no_epg(web_group, section)):
            web_no_epg_groups.add(web_group)
        web_edit = {}
        if channel_id:
            web_edit['epg'] = channel_id
            web_logo = index.icon.get(channel_id) or stream['icon']
            if web_logo:
                web_edit['logo'] = web_logo
        if category_is_divider or forced_no_epg or reason == 'override':
            web_edit['manual'] = True
            web_edit.setdefault('epg', None)
        web_display = display_category if category_is_divider else (renames.get(raw_name) or channel_name)
        if web_display != raw_name:
            web_edit['name'] = web_display
        if web_group != category:
            web_edit['group'] = web_group
        if raw_name in hidden:
            web_edit['hidden'] = True
        if web_edit:
            web_channels[raw_name] = web_edit

        # Canal oculto a mano desde la interfaz: queda en el reporte (para poder volver a
        # mostrarlo, con su EPG ya calculado) pero no entra a la playlist ni a la guía.
        # Lo mismo para una categoría entera oculta: cuenta la categoría donde el canal se
        # muestra (la movida a mano si la hay), así un canal rescatado a otra categoría sigue.
        if raw_name in hidden or (moved_to or category) in hidden_categories:
            hidden_count += 1
            continue

        # Sin match confirmado no hay logo: el de Xtream ("stream_icon") suele ser el del canal
        # equivocado que el proveedor le puso a último momento o un genérico, y mostrarlo da la
        # falsa impresión de que el canal sí tiene EPG asignado.
        logo = ''
        if channel_id:
            matched_ids.add(channel_id)
            matched_stream_count += 1
            logo = index.icon.get(channel_id) or stream['icon']

            # Cuando hay más de un candidato posible, el elegido y sus alternativas quedan en el
            # EPG del perfil con su display-name anotado (país/región/fuente) — no como entradas
            # extra en el M3U, sino para poder buscarlas y elegirlas a mano con la función
            # "Seleccionar EPG" del reproductor, que busca sobre toda la guía cargada.
            shown_ids = [channel_id] + [c.channel_id for c in alternatives]
            if len(shown_ids) > 1:
                for shown_id, label in _labeled_candidates(shown_ids, index):
                    matched_ids.add(shown_id)
                    channel_display_labels[shown_id] = label

            tvg_id = channel_id
        else:
            # Los separadores decorativos y los canales con "forzar sin EPG" no tienen EPG a
            # propósito (ver arriba): no cuentan como canales sin matchear, sería ruido en el
            # reporte hacerlo pasar por un caso a revisar cuando ya se revisó y se decidió así.
            if not category_is_divider and not forced_no_epg:
                unmatched.append(channel_name)
            tvg_id = channel_name

        # El separador muestra el mismo texto simple tanto en el group-title como en el nombre
        # del canal (su único ítem): el placeholder crudo del proveedor ("== 24 /7 Only ==")
        # no debería quedar visible en ningún lado.
        display_name = display_category if category_is_divider else (renames.get(raw_name) or channel_name)

        entries.append((
            section_order.get(section, no_section_order),
            cat_order,
            i,
            f'#EXTINF:-1 tvg-id="{_m3u_attr(tvg_id)}" tvg-name="{_m3u_attr(display_name)}" '
            f'tvg-logo="{_m3u_attr(logo)}" '
            f'group-title="{_m3u_attr(_safe_group_title(display_category))}",{_m3u_attr(display_name)}\n{stream_url}',
        ))

    entries.sort(key=lambda e: (e[0], e[1], e[2]))

    out_dir = os.path.join(OUTPUT_DIR, name)
    os.makedirs(out_dir, exist_ok=True)

    playlist_path = os.path.join(out_dir, 'playlist.m3u8')
    with open(playlist_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(['#EXTM3U'] + [e[3] for e in entries]) + '\n')

    epg_path = os.path.join(out_dir, 'epg.xml.gz')
    stats = {
        'profile': name,
        'total': len(live_streams),
        'matched': matched_stream_count,
        'unmatched': len(unmatched),
        'alternatives': len(matched_ids) - matched_stream_count,
    }
    report_path = os.path.join(out_dir, 'match_report.json')
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump({'stats': stats, 'channels': report}, f, ensure_ascii=False, indent=1)

    write_web_import(os.path.join(out_dir, 'grilla_import.json'), web_channels, web_groups, web_hidden_groups,
                     web_no_epg_groups, web_epg_config)

    print(f"📊 Canales: {stats['total']} | con EPG: {stats['matched']} | sin EPG: {stats['unmatched']}"
          + (f" | ocultos: {hidden_count}" if hidden_count else ''))
    if unmatched:
        print(f"   Ejemplos sin match: {', '.join(unmatched[:15])}")
    if stats['alternatives']:
        print(f"   Alternativas de EPG agregadas a la guía: {stats['alternatives']}")
    print(f"✅ {playlist_path} y {report_path} generados ({epg_path} se escribe al recorrer la guía)")
    return ProfileEpg(epg_path, channels_root, matched_ids, channel_display_labels, stats)


def write_web_import(path, channels, groups, hidden_groups, no_epg_groups=(), epg_config=None):
    """Lo que Grilla web necesita para quedar igual que esta playlist ("Importar desde Grilla
    (GitHub)"): la edición de cada canal por su nombre crudo (EPG elegido, logo, nombre visible,
    categoría, oculto) y el orden de las categorías, con sus separadores. Sin credenciales ni
    URLs: se publica en la branch `data` junto al match_report."""
    order = []
    for *_, group in sorted(groups, key=lambda g: g[:3]):
        if group not in order:
            order.append(group)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'version': 1, 'channels': channels,
                   'groups': {'order': order, 'hidden': sorted(hidden_groups), 'noEpg': sorted(no_epg_groups)},
                   # Cómo elige la guía esta corrida, para que la web elija igual en los canales
                   # nuevos: umbral, señal horaria preferida y país/fuentes por categoría cruda.
                   'matching': {'minScore': _rules.min_assign_score, 'feed': _rules.preferred_feed,
                                'categories': epg_config or {}}},
                  f, ensure_ascii=False, separators=(',', ':'))


class ProfileEpg:
    """Guía acotada de un perfil: sus canales (el elegido y las alternativas de cada canal de
    la playlist) y sus programas, escrita de forma incremental mientras se recorre la guía."""

    def __init__(self, path, channels_root, matched_ids, labels, stats):
        self.path = path
        self.channels_root = channels_root
        self.matched_ids = matched_ids
        self.labels = labels
        self.stats = stats
        self._xf = None

    def open(self, stack):
        """Abre el archivo y escribe los <channel>; los <programme> van con write_programme."""
        f = stack.enter_context(gzip.open(self.path, 'wb'))
        f.write(b'<?xml version="1.0" encoding="UTF-8" ?>\n')
        self._xf = stack.enter_context(etree.xmlfile(f, encoding='utf-8'))
        stack.enter_context(self._xf.element('tv', attrib=dict(self.channels_root.attrib)))
        self._xf.write('\n')
        for channel in self.channels_root.findall('channel'):
            channel_id = channel.get('id')
            if channel_id not in self.matched_ids:
                continue
            # Copia: la anotación del display-name de un perfil no se filtra al de otro.
            channel = copy.deepcopy(channel)
            label = self.labels.get(channel_id)
            if label:
                # La etiqueta va al PRINCIPIO del display-name para que no quede cortada si el
                # reproductor trunca los nombres largos por el lado derecho.
                first = channel.find('display-name')
                if first is not None:
                    first.text = f"[{label}] {first.text or ''}".strip()
            channel.tail = None
            self._xf.write(channel, pretty_print=True)

    def write_programme(self, programme):
        if programme.get('channel') in self.matched_ids:
            self._xf.write(programme, pretty_print=True)


def load_epg_channels(path=MERGED_EPG_PATH):
    """Solo los <channel> de merged.xml.gz (unos pocos MB en vez del árbol entero). merge_epgs.py
    escribe todos los canales antes que el primer programa, así que se corta ahí."""
    root = etree.Element('tv')
    with gzip.open(path, 'rb') as f:
        for _, el in etree.iterparse(f, events=('end',), tag=('channel', 'programme'), huge_tree=True):
            if el.tag == 'programme':
                break
            channel = copy.deepcopy(el)
            channel.tail = None
            root.append(channel)
            el.clear()
    return root


def iter_programmes(path=MERGED_EPG_PATH):
    """Los <programme> de merged.xml.gz de a uno, liberando cada uno después de usarlo."""
    with gzip.open(path, 'rb') as f:
        for _, el in etree.iterparse(f, events=('end',), tag='programme', huge_tree=True):
            el.tail = None  # el pretty_print de cada guía pone su propio salto de línea
            yield el
            el.clear()
            parent = el.getparent()
            while el.getprevious() is not None:
                del parent[0]


def _parse_xmltv_time(raw):
    """'20240101100000 +0000' -> datetime UTC. None si el formato no matchea (algunas fuentes
    traen basura puntual; se descarta esa franja en vez de romper toda la corrida)."""
    m = _XMLTV_TIME_RE.match((raw or '').strip())
    if not m:
        return None
    dt = datetime.datetime.strptime(m.group(1), '%Y%m%d%H%M%S')
    tz = m.group(2)
    if tz:
        sign = 1 if tz[0] == '+' else -1
        offset = datetime.timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5])) * sign
        dt -= offset
    return dt.replace(tzinfo=datetime.timezone.utc)


def _programme_desc(programme):
    """Descripción del programa para mostrar en la interfaz: <desc>, o si no hay, el
    <sub-title> (nombre del episodio). Espacios normalizados y recortada a SCHEDULE_DESC_MAX."""
    for tag in ('desc', 'sub-title'):
        text = ' '.join((programme.findtext(tag) or '').split())
        if text:
            return text if len(text) <= SCHEDULE_DESC_MAX else text[:SCHEDULE_DESC_MAX - 1].rstrip() + '…'
    return ''


def _schedule_filename(channel_id):
    # El channel_id puede traer '#', espacios, etc.: no sirve directo como nombre de archivo ni
    # como para armarlo desde JS sin duplicar la codificación en los dos lados. Un hash corto
    # evita ese problema — el nombre exacto viaja ya resuelto en epg_catalog.json (campo 'sched').
    return hashlib.sha1(channel_id.encode('utf-8')).hexdigest()[:16]


class ScheduleCollector:
    """Programación de la ventana [ahora - 1h, ahora + 30h] para la interfaz de corrección
    (docs/): un archivo por canal y un índice por hora. Se alimenta de a un programa (add) para
    poder armarla mientras se recorre la guía en streaming, y se escribe al final (write)."""

    def __init__(self, now=None):
        now = now or datetime.datetime.now(datetime.timezone.utc)
        self.window_start = now - SCHEDULE_WINDOW_PAST
        self.window_end = now + SCHEDULE_WINDOW_FUTURE
        # Pre-filtro barato por texto antes de parsear fecha en cada programa: un canal suele
        # traer varios días de guía y acá solo interesa una ventana corta.
        self.lo = (self.window_start - datetime.timedelta(days=1)).strftime('%Y%m%d')
        self.hi = (self.window_end + datetime.timedelta(days=1)).strftime('%Y%m%d')
        self.by_channel = {}

    def add(self, programme):
        start_raw = programme.get('start') or ''
        if not (self.lo <= start_raw[:8] <= self.hi):
            return
        start = _parse_xmltv_time(start_raw)
        stop = _parse_xmltv_time(programme.get('stop'))
        if not start or not stop or stop <= self.window_start or start >= self.window_end:
            return
        channel_id = programme.get('channel')
        title_elem = programme.find('title')
        title = (title_elem.text or '').strip() if title_elem is not None else ''
        if not channel_id or not title:
            return
        self.by_channel.setdefault(channel_id, []).append(
            (int(start.timestamp()), int(stop.timestamp()), title, _programme_desc(programme)))

    def write(self, out_dir=SCHEDULE_DIR):
        """Cada entrada por canal es [inicio, fin, título] y, si la guía la trae, la descripción
        como cuarto elemento (la interfaz la baja recién cuando se pide). Devuelve
        {channel_id: nombre_de_archivo} (sin extensión) de los canales con programación."""
        os.makedirs(out_dir, exist_ok=True)
        sched_by_channel = {}
        for channel_id, entries in self.by_channel.items():
            entries.sort()
            filename = _schedule_filename(channel_id)
            with open(os.path.join(out_dir, f'{filename}.json'), 'w', encoding='utf-8') as f:
                json.dump([[start, stop, title, desc] if desc else [start, stop, title]
                           for start, stop, title, desc in entries[:SCHEDULE_MAX_ENTRIES]],
                          f, ensure_ascii=False, separators=(',', ':'))
            sched_by_channel[channel_id] = filename

        write_hourly_index(
            {cid: entries[:SCHEDULE_MAX_ENTRIES] for cid, entries in self.by_channel.items()},
            os.path.join(out_dir, SCHEDULE_HOUR_SUBDIR), self.window_start, self.window_end)

        print(f"📺 {out_dir}: programación de {len(sched_by_channel)} canales "
              f"(ventana -{SCHEDULE_WINDOW_PAST}/+{SCHEDULE_WINDOW_FUTURE})")
        return sched_by_channel


def write_schedule_snapshot(epg_root, out_dir=SCHEDULE_DIR, now=None):
    """ScheduleCollector sobre un árbol ya cargado (lo usan los tests)."""
    collector = ScheduleCollector(now)
    for programme in epg_root.findall('programme'):
        collector.add(programme)
    return collector.write(out_dir)


def write_hourly_index(by_channel, out_dir, window_start, window_end):
    """Un archivo por hora UTC de la ventana, con los programas de todos los canales que se
    solapan con esa hora: {"h": inicio_de_la_hora, "t": [títulos],
    "c": {channel_id: [[inicio, fin, i_título], ...]}}, con inicio/fin en minutos relativos a
    "h" (números cortos en vez de timestamps: son decenas de miles de entradas por archivo).
    Los títulos van deduplicados aparte porque muchos canales repiten el mismo (feeds regionales
    del mismo canal, "Paid Programming", etc.)."""
    first_hour = int(window_start.replace(minute=0, second=0, microsecond=0).timestamp())
    last_hour = int(window_end.timestamp())
    buckets = {h: ([], {}, {}) for h in range(first_hour, last_hour, 3600)}
    for channel_id, entries in by_channel.items():
        for start, stop, title, *_ in entries:
            h = max(first_hour, start - (start - first_hour) % 3600)
            while h < stop and h in buckets:
                titles, title_idx, channels = buckets[h]
                if title not in title_idx:
                    title_idx[title] = len(titles)
                    titles.append(title)
                channels.setdefault(channel_id, []).append(
                    [(start - h) // 60, (stop - h) // 60, title_idx[title]])
                h += 3600

    os.makedirs(out_dir, exist_ok=True)
    for h, (titles, _, channels) in buckets.items():
        name = datetime.datetime.fromtimestamp(h, datetime.timezone.utc).strftime('%Y%m%d%H')
        with open(os.path.join(out_dir, f'{name}.json'), 'w', encoding='utf-8') as f:
            json.dump({'h': h, 't': titles, 'c': channels}, f, ensure_ascii=False, separators=(',', ':'))
    return len(buckets)


def write_epg_catalog(index, sched_by_channel, path=EPG_CATALOG_PATH):
    """Todo el universo de channel_id posibles (nombre, país, fuente, y el archivo de
    programación si hay uno), sin credenciales, para que la interfaz de corrección manual
    (docs/) pueda ofrecer "cualquier canal del EPG" como alternativa, no solo los 4 candidatos
    que ya trae el match_report de cada perfil."""
    catalog = [
        {
            'id': channel_id,
            'name': index.display_name.get(channel_id) or channel_id,
            'country': index.country.get(channel_id),
            'source': index.source.get(channel_id),
            'sched': sched_by_channel.get(channel_id),
        }
        for channel_id in index.parsed
    ]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, ensure_ascii=False, separators=(',', ':'))
    print(f"📚 {path}: {len(catalog)} canales del EPG completo")


def write_epg_icons(index, path=EPG_ICONS_PATH):
    """{channel_id: url del logo} de los canales del EPG que traen <icon>, para mostrar logos en
    la interfaz de corrección (docs/). Va aparte de epg_catalog.json porque la interfaz lo baja
    en segundo plano, sin demorar la primera carga. Las URLs http:// se pasan a https:// (la
    página se sirve por https y el navegador bloquearía o reescribiría la imagen igual; los
    hosts de logos que usan las fuentes responden por https)."""
    icons = {}
    for channel_id in index.parsed:
        url = (index.icon.get(channel_id) or '').strip()
        if url.startswith('http://'):
            url = 'https://' + url[len('http://'):]
        if url.startswith('https://'):
            icons[channel_id] = url
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(icons, f, ensure_ascii=False, separators=(',', ':'))
    print(f"🖼️  {path}: logos de {len(icons)} canales del EPG")


def generate():
    profiles = load_profiles()
    if not profiles:
        print("ℹ️  Sin perfiles configurados (XTREAM_PROFILES o XTREAM_USERNAME/PASSWORD/SERVERS); "
              "se omite la generación de playlists")
        return

    if not os.path.exists(MERGED_EPG_PATH):
        print(f"❌ Falta {MERGED_EPG_PATH}; corré primero: python merge_epgs.py")
        return

    set_provider_rules(load_provider_rules())
    channel_db = load_channel_db()
    set_channel_db(channel_db)
    if channel_db:
        print(f"📖 Diccionario de canales de iptv-org: {len(channel_db)} canales")
    t0 = time.monotonic()
    elapsed = lambda: f"{time.monotonic() - t0:.0f}s"  # noqa: E731

    channels_root = load_epg_channels()
    sources = {s['id']: s for s in load_sources()}
    index = EpgIndex(channels_root, sources=sources)
    index.preferred_feed = _rules.preferred_feed
    print(f"🗂️  EPG indexado: {len(index.parsed)} canales, {len(index.postings)} tokens [{elapsed()}]")
    write_epg_icons(index)

    # Un override que apunte a un channel_id inexistente en el EPG sería un tvg-id colgado.
    # `null` es un valor válido a propósito: "forzar sin EPG" (ver forced_no_epg más abajo),
    # no un channel_id colgado.
    overrides_raw = load_channel_map()
    invalid = [n for n, cid in overrides_raw.items() if cid is not None and cid not in index]
    if invalid:
        print(f"⚠️  {len(invalid)} override(s) en {CHANNEL_MAP_PATH} apuntan a un channel_id "
              f"inexistente en el EPG, se ignoran: {', '.join(invalid[:5])}")
    overrides = {n: cid for n, cid in overrides_raw.items() if cid is None or cid in index}

    sections = load_sections_config()
    edits = load_channel_edits()
    if any(edits):
        print(f"✏️  Ediciones manuales: {len(edits[0])} renombrado(s), "
              f"{len(edits[1])} cambio(s) de categoría, {len(edits[2])} oculto(s), "
              f"{len(edits[3])} categoría(s) oculta(s)")

    print(f"👥 Perfiles configurados: {', '.join(p['name'] for p in profiles)}")
    no_epg_categories = load_no_epg_categories()
    guides = [g for g in (generate_for_profile(profile, index, channels_root, sections, overrides, edits,
                                                 no_epg_categories)
                          for profile in profiles) if g]
    print(f"\n⏱️  Matching de {len(guides)} perfil(es) listo [{elapsed()}]; recorriendo la guía…")

    # Segunda pasada: cada programa va a la programación de la interfaz y a la guía de los
    # perfiles que lo usan, y se libera.
    collector = ScheduleCollector()
    count = 0
    with contextlib.ExitStack() as stack:
        for guide in guides:
            guide.open(stack)
        for programme in iter_programmes():
            collector.add(programme)
            for guide in guides:
                guide.write_programme(programme)
            count += 1
    print(f"📼 {count} programas recorridos; guías de perfil escritas [{elapsed()}]")
    sched_by_channel = collector.write()
    write_epg_catalog(index, sched_by_channel)
    print(f"✅ Listo [{elapsed()}]")


if __name__ == '__main__':
    generate()
