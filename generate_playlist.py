#!/usr/bin/env python3
"""Genera, por cada perfil configurado, su playlist y su EPG acotado.

Cruza la lista real de canales de Xtream Codes con el EPG ya fusionado por merge_epgs.py.
`merged.xml.gz` se parsea e indexa **una sola vez** y se reutiliza para todos los perfiles:
la parte cara del trabajo es la misma para todo el mundo, lo único que cambia entre personas
son las credenciales que van dentro de la URL del stream.
"""
import copy
import gzip
import json
import os
import re
import unicodedata

from lxml import etree

from channel_names import flag_to_country_code, parse_channel_name, strip_accents, strip_display_prefix
from epg_index import MIN_SCORE, PLAUSIBLE_MIN, EpgIndex
from merge_epgs import load_sources
from profiles import OUTPUT_DIR, load_profiles
from xtream_client import XtreamError, build_stream_url, get_live_categories, get_live_streams

MERGED_EPG_PATH = 'merged.xml.gz'
CHANNEL_MAP_PATH = 'xtream_channel_map.json'
SECTIONS_CONFIG_PATH = 'playlist_sections.json'

# Cuántos candidatos alternativos incluir (con display-name anotado) en el EPG del perfil
# cuando un canal tiene varios EPG posibles (ej. "E!" existe para 17 países/feeds distintos) —
# sin este tope, un solo canal ambiguo podría inflar el EPG con decenas de candidatos.
MAX_ALT_ENTRIES = 4


# --------------------------------------------------------------------- categorías y secciones

# Categorías "separador" decorativas que el proveedor usa como divisores visuales en su propio
# panel (ej. "▆▆▆ＰＰＶ　ＥＶＥＮＴＳ▆▆▆"). Se conservan pero se reubican como encabezado al
# principio de la sección real que les corresponde.
DIVIDER_CATEGORY_RE = re.compile(r'[▆░▒▓█]')


def is_divider_category(category):
    return bool(DIVIDER_CATEGORY_RE.search(category))


def _divider_key(category):
    """'▆▆▆ＤＥＰＯＲＴＥＳ ▆▆▆' -> 'deportes' (des-fullwidth + solo alfanumérico)."""
    text = unicodedata.normalize('NFKC', category)
    text = strip_accents(text).lower()
    return re.sub(r'[^a-z0-9]', '', text)


DIVIDER_SECTION_MAP = {
    _divider_key('PPV EVENTS'): 'PPV EVENTS',
    _divider_key('PAISES'): 'PAÍSES',
    _divider_key('DEPORTES'): 'DEPORTES',
    _divider_key('ENGLISH'): 'ENGLISH',
    _divider_key('ESPAÑOL'): 'ESPAÑOL',
    _divider_key('LATINOS USA'): 'LATINOS USA',
    _divider_key('24/7'): '24/7',
}

# El proveedor nombra el separador de esta sección con dígitos de ancho completo y una barra
# ("▆▆▆２４／７▆▆▆"): se prueba si un texto simple, sin caracteres especiales, se muestra mejor
# en los reproductores que el decorativo original.
DIVIDER_DISPLAY_OVERRIDE = {
    '24/7': '24 7',
}


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
    return _ordered_names(config.get('order', [])), matchers, section_epg, category_order


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
        return DIVIDER_SECTION_MAP.get(_divider_key(category))  # None si no está mapeado (ej. ADULTS)

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
    if ranked and ranked[0].score >= MIN_SCORE:
        return ranked[0].channel_id, ranked[0].reason, ranked[0].score, ranked
    return None, None, 0.0, ranked


def generate_for_profile(profile, index, epg_root, sections, overrides):
    """Genera playlist, EPG acotado y reporte de matching para un perfil. Devuelve stats."""
    section_display_order, section_rules, section_epg, category_order = sections
    name = profile['name']
    username, password = profile['username'], profile['password']

    print(f"\n{'=' * 60}\n👤 Perfil: {name}")
    try:
        active_server, live_streams = get_live_streams(profile['servers'], username, password)
    except XtreamError as e:
        print(f"❌ No se pudo obtener la lista de canales de Xtream: {e}")
        return None

    categories = get_live_categories(active_server, username, password)
    print(f"📂 Categorías encontradas: {len(categories)}")

    matched_ids = set()        # channel_id que quedan en el EPG del perfil (elegido + alternativas)
    matched_stream_count = 0
    channel_display_labels = {}
    unmatched = []
    entries = []               # (orden_seccion, orden_categoria, indice_original, líneas m3u)
    report = []

    section_order = {s: i for i, s in enumerate(section_display_order)}
    no_section_order = len(section_display_order)  # categorías sin sección van al final

    # classify_section/is_divider_category/flag_to_country_code solo dependen de `category`
    # (~99 valores únicos), no de cada canal (~3000+): se calculan una vez por categoría.
    category_info_cache = {}

    def category_info(category):
        info = category_info_cache.get(category)
        if info is None:
            section = classify_section(category, section_rules)
            is_divider = is_divider_category(category)
            # Una categoría divisor con sección mapeada va primero como encabezado (0,).
            # Si la sección declaró 'category_order', se respeta esa posición exacta (1, i).
            # Una categoría nueva del proveedor que no esté en esa lista, o si la sección no
            # declaró orden, se ordena alfabéticamente y va al final de las que sí están listadas.
            explicit_pos = category_order.get(section, {}).get(_strip_category_label(category))
            if is_divider and section:
                sort_key = (0,)
            elif explicit_pos is not None:
                sort_key = (1, explicit_pos)
            else:
                sort_key = (2, _strip_category_label(category))
            display_category = DIVIDER_DISPLAY_OVERRIDE.get(section, category) if is_divider else category
            info = (
                section,
                is_divider,
                flag_to_country_code(category),
                section_epg.get(section, {}),
                sort_key,
                display_category,
            )
            category_info_cache[category] = info
        return info

    for i, stream in enumerate(live_streams):
        category = categories.get(str(stream.get('category_id')), 'General')
        raw_name = stream.get('name', '')
        stream_id = stream.get('stream_id')
        container_ext = stream.get('container_extension', 'm3u8')
        section, category_is_divider, category_country, epg_config, cat_order, display_category = category_info(category)

        # Se saca el prefijo que antepone el proveedor (código de país, número de evento) del
        # nombre que se muestra y del que se matchea — pero los overrides de
        # xtream_channel_map.json siguen buscándose por el nombre CRUDO, tal como aparece en
        # Xtream, que es lo que la persona que configura el override tiene copiado del panel.
        channel_name, prefix_country = strip_display_prefix(raw_name, index.rules)

        if category_is_divider:
            # El placeholder que el proveedor usa como separador visual ("== 24 /7 Only ==")
            # no es un canal real: matchearlo contra el EPG solo arriesga un falso positivo de
            # bajo puntaje que termine compartiendo tvg-id con un canal real (pasó con "COCINA
            # 24/7", que un match débil por los tokens "24"/"7" mandó al mismo channel_id que
            # este separador — y varios reproductores, TiviMate confirmado, esconden uno de los
            # dos cuando dos entradas comparten tvg-id).
            channel_id, reason, score, ranked = None, None, 0.0, []
        else:
            parsed = parse_channel_name(channel_name, index.rules)
            channel_id, reason, score, ranked = match_channel(
                raw_name, parsed, index, overrides, epg_config, prefix_country or category_country,
            )

            if not channel_id:
                # Xtream trae su propio "epg_channel_id", que es una adivinanza del proveedor
                # sin verificar: a veces es el mismo id "por defecto" para una docena de
                # canales sin relación entre sí. Solo se acepta si el canal apuntado existe en
                # nuestro EPG y además su nombre real tiene algo que ver con el del canal de
                # Xtream.
                candidate = stream.get('epg_channel_id')
                if candidate and candidate in index:
                    plausibility = index.best_name_score(parsed, candidate)
                    if plausibility >= PLAUSIBLE_MIN:
                        channel_id, reason, score = candidate, 'xtream_epg_id', plausibility

        stream_url = build_stream_url(active_server, username, password, stream_id, container_ext)
        alternatives = [
            c for c in ranked
            if c.channel_id != channel_id and c.score >= PLAUSIBLE_MIN
        ][:MAX_ALT_ENTRIES]

        logo = stream.get('stream_icon', '')
        if channel_id:
            matched_ids.add(channel_id)
            matched_stream_count += 1
            logo = index.icon.get(channel_id) or logo

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
            # Los separadores decorativos nunca tienen EPG a propósito (ver arriba): no cuentan
            # como canales sin matchear, sería ruido en el reporte.
            if not category_is_divider:
                unmatched.append(channel_name)
            tvg_id = channel_name

        # El separador muestra el mismo texto simple tanto en el group-title como en el nombre
        # del canal (su único ítem): el placeholder crudo del proveedor ("== 24 /7 Only ==")
        # no debería quedar visible en ningún lado.
        display_name = display_category if category_is_divider else channel_name

        entries.append((
            section_order.get(section, no_section_order),
            cat_order,
            i,
            f'#EXTINF:-1 tvg-id="{_m3u_attr(tvg_id)}" tvg-name="{_m3u_attr(display_name)}" '
            f'tvg-logo="{_m3u_attr(logo)}" '
            f'group-title="{_m3u_attr(_safe_group_title(display_category))}",{_m3u_attr(display_name)}\n{stream_url}',
        ))

        # El reporte no lleva URLs de stream: se publica/diffea sin credenciales adentro.
        report.append({
            'xtream_name': raw_name,
            'category': category,
            'section': section,
            'chosen': channel_id,
            'reason': reason,
            'score': round(score, 4),
            'alternatives': [
                {'channel_id': c.channel_id, 'score': round(c.score, 4),
                 'source': index.source.get(c.channel_id)}
                for c in alternatives
            ],
        })

    entries.sort(key=lambda e: (e[0], e[1], e[2]))

    out_dir = os.path.join(OUTPUT_DIR, name)
    os.makedirs(out_dir, exist_ok=True)

    playlist_path = os.path.join(out_dir, 'playlist.m3u8')
    with open(playlist_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(['#EXTM3U'] + [e[3] for e in entries]) + '\n')

    # deepcopy y no append directo: appendear mueve el elemento fuera de `epg_root`, y el
    # árbol se reutiliza para los perfiles siguientes. También evita que la anotación del
    # display-name de un perfil se filtre al de otro.
    filtered_root = etree.Element('tv', attrib=dict(epg_root.attrib))
    for channel in epg_root.findall('channel'):
        channel_id = channel.get('id')
        if channel_id not in matched_ids:
            continue
        channel = copy.deepcopy(channel)
        label = channel_display_labels.get(channel_id)
        if label:
            # La etiqueta va al PRINCIPIO del display-name para que no quede cortada si el
            # reproductor trunca los nombres largos por el lado derecho.
            first = channel.find('display-name')
            if first is not None:
                first.text = f"[{label}] {first.text or ''}".strip()
        filtered_root.append(channel)
    for programme in epg_root.findall('programme'):
        if programme.get('channel') in matched_ids:
            filtered_root.append(copy.deepcopy(programme))

    body = etree.tostring(filtered_root, encoding='utf-8', xml_declaration=False, pretty_print=True)
    epg_path = os.path.join(out_dir, 'epg.xml.gz')
    with gzip.open(epg_path, 'wb') as f:
        f.write(b'<?xml version="1.0" encoding="UTF-8" ?>\n' + body)

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

    print(f"📊 Canales: {stats['total']} | con EPG: {stats['matched']} | sin EPG: {stats['unmatched']}")
    if unmatched:
        print(f"   Ejemplos sin match: {', '.join(unmatched[:15])}")
    if stats['alternatives']:
        print(f"   Alternativas de EPG agregadas a la guía: {stats['alternatives']}")
    print(f"✅ {playlist_path}, {epg_path} y {report_path} generados")
    return stats


def generate():
    profiles = load_profiles()
    if not profiles:
        print("ℹ️  Sin perfiles configurados (XTREAM_PROFILES o XTREAM_USERNAME/PASSWORD/SERVERS); "
              "se omite la generación de playlists")
        return

    if not os.path.exists(MERGED_EPG_PATH):
        print(f"❌ Falta {MERGED_EPG_PATH}; corré primero: python merge_epgs.py")
        return

    with gzip.open(MERGED_EPG_PATH, 'rb') as f:
        epg_root = etree.fromstring(f.read())

    sources = {s['id']: s for s in load_sources()}
    index = EpgIndex(epg_root, sources=sources)
    print(f"🗂️  EPG indexado: {len(index.parsed)} canales, {len(index.postings)} tokens")

    # Un override que apunte a un channel_id inexistente en el EPG sería un tvg-id colgado.
    overrides_raw = load_channel_map()
    invalid = [n for n, cid in overrides_raw.items() if cid not in index]
    if invalid:
        print(f"⚠️  {len(invalid)} override(s) en {CHANNEL_MAP_PATH} apuntan a un channel_id "
              f"inexistente en el EPG, se ignoran: {', '.join(invalid[:5])}")
    overrides = {n: cid for n, cid in overrides_raw.items() if cid in index}

    sections = load_sections_config()

    print(f"👥 Perfiles configurados: {', '.join(p['name'] for p in profiles)}")
    for profile in profiles:
        generate_for_profile(profile, index, epg_root, sections, overrides)


if __name__ == '__main__':
    generate()
