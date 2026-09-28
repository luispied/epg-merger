#!/usr/bin/env python3
"""Uso de las fuentes de EPG y sugerencias según los canales del usuario → out/sources_report.json.

Corre después de generate_playlist.py, con lo que esa corrida dejó:

- **uso por fuente:** entre los canales visibles (sin ocultos, categorías ocultas ni
  separadores), cuántos usan como guía un canal de cada fuente y cuántas veces aparece como
  alternativa. Las fuentes activas que no usa nadie quedan en `unused_active`, candidatas a
  desactivar (una fuente de menos es una descarga de menos en cada corrida).
- **países detectados:** de los canales visibles que siguen sin guía (bandera de la categoría,
  prefijo del nombre como "AR|", país dicho en el nombre) más el país de las guías ya elegidas.
- **sugerencias:** fuentes `fresh` del catálogo (epg_sources_catalog.json), todavía no
  agregadas, de esos países. Se bajan, se suman al índice sus canales con programación en las
  próximas 24 h y se corre el matcher real sobre los canales sin guía: la ganancia es cuántos
  quedarían con guía firme (puntaje ≥ 0.9) y cuántos con una dudosa.

La interfaz (docs/, Configuración → Fuentes de EPG) lee este reporte desde la branch `data`.

Uso: `python tools/source_coverage.py [--max-candidates 20] [--no-download]`.
"""
import argparse
import collections
import copy
import datetime
import glob
import io
import json
import os
import re
import sys
from urllib.parse import urlparse

from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generate_playlist as gp  # noqa: E402
from channel_names import flag_to_country_code, parse_channel_name, strip_display_prefix  # noqa: E402
from epg_http import download_all  # noqa: E402
from epg_index import MIN_SCORE, EpgIndex  # noqa: E402
from merge_epgs import CATALOG_PATH, SOURCES_PATH, _source_id_from_url, load_catalog  # noqa: E402
from profiles import OUTPUT_DIR  # noqa: E402

REPORT_PATH = os.path.join(OUTPUT_DIR, 'sources_report.json')
FIRM_SCORE = 0.9
MAX_CANDIDATES = 20
MAX_EXAMPLES = 5
WINDOW = datetime.timedelta(hours=24)


# ------------------------------------------------------------------------------ entradas

def load_reports(pattern=None):
    """{perfil: [canales del match_report]} de out/<perfil>/match_report.json."""
    pattern = pattern or os.path.join(OUTPUT_DIR, '*', 'match_report.json')
    reports = {}
    for path in sorted(glob.glob(pattern)):
        with open(path, encoding='utf-8') as f:
            reports[os.path.basename(os.path.dirname(path))] = json.load(f).get('channels', [])
    return reports


def load_map(path=gp.CHANNEL_MAP_PATH):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def load_user_sources(path=SOURCES_PATH):
    """Todas las entradas de epg_urls.json, activas e inactivas, con el id que usa el merge."""
    try:
        with open(path, encoding='utf-8') as f:
            config = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    raw = config.get('sources')
    if raw is None:
        raw = config.get('urls', [])
    entries = []
    for entry in raw:
        if isinstance(entry, str):
            entry = {'url': entry}
        url = (entry.get('url') or '').strip()
        active = entry.get('active', True) is not False and not url.startswith('#')
        entries.append({
            'id': entry.get('id') or _source_id_from_url(url.lstrip('#')),
            'url': url.lstrip('#').strip() or None,
            'country': entry.get('country'),
            'active': active,
            'inactive_reason': entry.get('inactive_reason'),
        })
    return entries


class _NoEpg:
    """provider_rules.json → no_epg, más las categorías marcadas "sin guía" desde la interfaz."""

    def __init__(self, rules, channel_map):
        ne = rules.get('no_epg') or {}
        self.categories = set(ne.get('categories') or [])
        self.sections = set(ne.get('sections') or [])
        self.patterns = [re.compile(p, re.I) for p in ne.get('category_patterns') or []]
        self.categories |= {k for k, v in (channel_map.get('no_epg_categories') or {}).items() if v}
        # Los eventos sueltos (PPV) no los cubre ninguna guía pública, salvo las categorías
        # editables (las mismas que la interfaz deja corregir).
        events = rules.get('event_sections') or {}
        self.event_sections = set(events.get('sections') or [])
        self.editable = set(events.get('editable_categories') or [])

    def __call__(self, category, section):
        if section in self.event_sections and category not in self.editable:
            return True
        return (category in self.categories or section in self.sections
                or any(p.search(category) for p in self.patterns))


# ------------------------------------------------------------------------------ análisis

def visible_channels(reports, channel_map, section_rules):
    """Canales que se ven en alguna playlist, sin repetir entre perfiles (mismo nombre crudo =
    mismo canal), con la categoría y sección donde se muestran."""
    hidden = {k for k, v in (channel_map.get('hidden') or {}).items() if v}
    hidden_categories = {k for k, v in (channel_map.get('hidden_categories') or {}).items() if v}
    moves = channel_map.get('categories') or {}
    seen = {}
    for channels in reports.values():
        for ch in channels:
            name = ch['xtream_name']
            if name in seen or gp.is_divider_category(ch['category']):
                continue
            shown = moves.get(name) or ch['category']
            if name in hidden or shown in hidden_categories:
                continue
            section = gp.classify_section(shown, section_rules) if shown != ch['category'] else ch.get('section')
            seen[name] = {**ch, 'shown_category': shown, 'shown_section': section}
    return list(seen.values())


def source_usage(channels, source_of):
    """({fuente: canales que la usan}, {fuente: veces que aparece como alternativa})."""
    used, alt = collections.Counter(), collections.Counter()
    for ch in channels:
        if ch.get('chosen'):
            used[source_of(ch['chosen'])] += 1
        for a in ch.get('alternatives') or []:
            alt[a.get('source') or source_of(a['channel_id'])] += 1
    return used, alt


def missing_channels(channels, no_epg):
    """Visibles sin guía que la necesitan: no forzados a "sin EPG" ni de categorías sin guía."""
    return [
        ch for ch in channels
        if not ch.get('chosen') and ch.get('reason') != 'override_none'
        and not no_epg(ch['shown_category'], ch.get('shown_section') or '')
    ]


def channel_country(ch, rules=None):
    """País de un canal del proveedor: prefijo del nombre ("AR|"), bandera de la categoría o
    país dicho en el nombre."""
    name, prefix_country = strip_display_prefix(ch['xtream_name'], rules)
    return (prefix_country or flag_to_country_code(ch['category'], rules)
            or parse_channel_name(name, rules).country)


def detect_countries(channels, missing, country_of_epg, rules=None):
    """[{country, missing, matched}] ordenado por canales sin guía (lo que más falta, primero)."""
    miss = collections.Counter(c for c in (channel_country(ch, rules) for ch in missing) if c)
    matched = collections.Counter(
        c for c in (country_of_epg(ch['chosen']) for ch in channels if ch.get('chosen')) if c
    )
    countries = set(miss) | set(matched)
    return sorted(
        ({'country': c, 'missing': miss[c], 'matched': matched[c]} for c in countries),
        key=lambda x: (-x['missing'], -x['matched'], x['country']),
    )


def pick_candidates(catalog, user_sources, countries, limit=MAX_CANDIDATES):
    """Fuentes fresh del catálogo que el usuario no tiene (ni activas ni inactivas), de los
    países con canales sin guía. Se reparten por turnos entre países (el que más faltantes
    tiene, primero) para que un país con muchos archivos no se lleve todo el cupo."""
    have_ids = {s['id'] for s in user_sources}
    have_urls = {s['url'] for s in user_sources if s.get('url')}
    order = [c['country'] for c in countries if c['missing']]
    by_country = {c: [] for c in order}
    for s in catalog.values():
        if (s.get('status') == 'fresh' and s['id'] not in have_ids and s['url'] not in have_urls
                and s.get('country') in by_country):
            by_country[s['country']].append(s)
    for items in by_country.values():
        items.sort(key=lambda s: (-(s.get('live_channels') or 0), s['id']))
    picks = []
    for turn in range(max((len(v) for v in by_country.values()), default=0)):
        picks += [by_country[c][turn] for c in order if turn < len(by_country[c])]
    return picks[:limit]


def live_channels_xml(data, source_id, known_ids, now):
    """<channel> de una fuente con programación en las próximas 24 h (y que no estén ya en la
    guía), con el atributo `source` como los deja merge_epgs.py."""
    lo = now.strftime('%Y%m%d%H%M%S')
    hi = (now + WINDOW).strftime('%Y%m%d%H%M%S')
    channels, live = {}, set()
    for _, el in etree.iterparse(io.BytesIO(data), events=('end',), tag=('channel', 'programme'),
                                 huge_tree=True, recover=True):
        if el.tag == 'channel':
            cid = el.get('id')
            if cid and cid not in known_ids and cid not in channels:
                el.set('source', source_id)
                el.tail = None
                channels[cid] = etree.fromstring(etree.tostring(el))
        elif (el.get('start') or '')[:14] < hi and (el.get('stop') or '')[:14] > lo:
            live.add(el.get('channel'))
        el.clear()
    return [ch for cid, ch in channels.items() if cid in live]


def measure_suggestions(channels_root, sources, candidates, fetched, missing, overrides, sections, now):
    """Ganancia de cada candidata sobre los canales sin guía, con el matcher real.

    `fetched`: [(candidata, bytes o None)]. Todas se suman juntas a la guía actual (como si se
    agregaran todas) y cada canal que consigue guía se le atribuye a la fuente del canal
    elegido — así dos candidatas que cubren lo mismo no se cuentan dos veces."""
    root = copy.deepcopy(channels_root)  # append() movería los <channel> del original
    known = {ch.get('id') for ch in root}
    all_sources = dict(sources)
    added = {}
    for n, (cand, data) in enumerate(fetched):
        if not data:
            continue
        chans = live_channels_xml(data, cand['id'], known, now)
        for ch in chans:
            root.append(ch)
            known.add(ch.get('id'))
        added[cand['id']] = len(chans)
        all_sources[cand['id']] = {'country': cand.get('country'), 'priority': 10 ** 5 + n}
    index = EpgIndex(root, sources=all_sources)

    _, section_rules, section_epg, _ = sections
    gains = {c['id']: {'firm': 0, 'doubtful': 0, 'examples': []} for c in candidates}
    for ch in missing:
        section = gp.classify_section(ch['category'], section_rules)
        name, prefix_country = strip_display_prefix(ch['xtream_name'], index.rules)
        parsed = parse_channel_name(name, index.rules)
        cid, _, score, _ = gp.match_channel(
            ch['xtream_name'], parsed, index, overrides, section_epg.get(section, {}),
            prefix_country or flag_to_country_code(ch['category'], index.rules),
        )
        gain = gains.get(index.source.get(cid)) if cid else None
        if gain is None or score < MIN_SCORE:
            continue
        gain['firm' if score >= FIRM_SCORE else 'doubtful'] += 1
        if len(gain['examples']) < MAX_EXAMPLES:
            gain['examples'].append({'channel': ch['xtream_name'], 'epg': index.display_name.get(cid) or cid,
                                     'score': round(score, 2)})
    return gains, added


# ------------------------------------------------------------------------------ reporte

def _provider(url):
    host = urlparse(url or '').netloc.lower()
    return re.sub(r'^www\.', '', host) or None


def build_report(user_sources, catalog, channels, missing, countries, source_of, suggestions, now):
    used, alt = source_usage(channels, source_of)
    by_url = {s['url']: s for s in catalog.values()}
    sources = []
    for s in user_sources:
        known = catalog.get(s['id']) or by_url.get(s['url']) or {}
        sources.append({
            'id': s['id'],
            'url': s['url'],
            'active': s['active'],
            'inactive_reason': s.get('inactive_reason'),
            'country': s.get('country') or known.get('country'),
            'provider': known.get('provider') or _provider(s['url']),
            'status': known.get('status'),
            'catalog_id': known.get('id'),
            'used_by': used.get(s['id'], 0),
            'alt_by': alt.get(s['id'], 0),
        })
    unused = [s['id'] for s in sources if s['active'] and not s['used_by']]
    return {
        'generated_at': now.strftime('%Y-%m-%dT%H:%MZ'),
        'summary': {
            'active': sum(1 for s in sources if s['active']),
            'inactive': sum(1 for s in sources if not s['active']),
            'unused_active': len(unused),
            'visible_channels': len(channels),
            'missing_channels': len(missing),
            'suggestions': len(suggestions),
        },
        'sources': sources,
        'unused_active': unused,
        'countries': countries,
        'suggestions': suggestions,
    }


def run(reports, channel_map, user_sources, catalog, channels_root, sections, rules,
        fetch=None, max_candidates=MAX_CANDIDATES, now=None):
    """Arma el reporte. `fetch(urls)` → [(url, bytes)] (por defecto epg_http.download_all);
    con `fetch=False` no se baja nada y las sugerencias quedan sin medir (solo candidatas)."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    _, section_rules, _, _ = sections
    source_attr = {ch.get('id'): ch.get('source') for ch in channels_root}
    source_of = source_attr.get

    active_sources = {s['id']: {'country': s.get('country'), 'priority': i}
                      for i, s in enumerate(user_sources) if s['active']}
    country_attr = {}
    for ch in channels_root:
        cid = ch.get('id')
        m = re.search(r'\.([a-z]{2})$', cid or '')
        country_attr[cid] = m.group(1) if m else (active_sources.get(ch.get('source')) or {}).get('country')

    channels = visible_channels(reports, channel_map, section_rules)
    missing = missing_channels(channels, _NoEpg(rules, channel_map))
    countries = detect_countries(channels, missing, country_attr.get)
    candidates = pick_candidates(catalog, user_sources, countries, max_candidates)

    suggestions = []
    if candidates:
        gains, added = {}, {}
        if fetch is not False:
            fetch = fetch or (lambda urls: list(download_all(urls, workers=4)))
            print(f"📥 Midiendo {len(candidates)} fuente(s) candidata(s)…")
            data = dict(fetch([c['url'] for c in candidates]))
            overrides = {k: v for k, v in (channel_map.get('overrides') or {}).items() if v}
            gains, added = measure_suggestions(
                channels_root, active_sources, candidates, [(c, data.get(c['url'])) for c in candidates],
                missing, overrides, sections, now,
            )
        for c in candidates:
            g = gains.get(c['id'], {})
            suggestions.append({
                'id': c['id'], 'url': c['url'], 'country': c.get('country'), 'provider': c.get('provider'),
                'live_channels': c.get('live_channels'), 'new_channels': added.get(c['id']),
                'measured': c['id'] in added,
                'firm': g.get('firm', 0), 'doubtful': g.get('doubtful', 0), 'examples': g.get('examples', []),
            })
        # Medidas: solo las que suman algo (una que no se pudo bajar tampoco), primero las que
        # más suman. Sin medir (--no-download) quedan todas las candidatas.
        if fetch is not False:
            suggestions = [s for s in suggestions if s['firm'] or s['doubtful']]
        suggestions.sort(key=lambda s: (-s['firm'], -s['doubtful']))  # estable: empates, en orden de candidata
    return build_report(user_sources, catalog, channels, missing, countries, source_of, suggestions, now)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--out', default=REPORT_PATH)
    parser.add_argument('--max-candidates', type=int, default=MAX_CANDIDATES)
    parser.add_argument('--no-download', action='store_true', help='no medir las candidatas')
    parser.add_argument('--merged', default=gp.MERGED_EPG_PATH)
    args = parser.parse_args(argv)

    reports = load_reports()
    if not reports:
        print(f"ℹ️  No hay {OUTPUT_DIR}/<perfil>/match_report.json; corré primero generate_playlist.py")
        return 0
    rules = gp.load_provider_rules()
    gp.set_provider_rules(rules)
    channels_root = gp.load_epg_channels(args.merged)
    report = run(
        reports, load_map(), load_user_sources(), load_catalog(CATALOG_PATH), channels_root,
        gp.load_sections_config(), rules,
        fetch=False if args.no_download else None, max_candidates=args.max_candidates,
    )
    os.makedirs(os.path.dirname(args.out) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    s = report['summary']
    print(f"✅ {args.out}: {s['active']} activas ({s['unused_active']} sin uso), {s['inactive']} inactivas; "
          f"{s['missing_channels']} de {s['visible_channels']} canales visibles sin guía; "
          f"{s['suggestions']} sugerencia(s)")
    for sug in report['suggestions'][:10]:
        print(f"   + {sug['id']} ({sug['country']}): {sug['firm']} firmes, {sug['doubtful']} dudosos")
    if report['unused_active']:
        print(f"   Sin uso: {', '.join(report['unused_active'])}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
