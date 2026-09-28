#!/usr/bin/env python3
"""Descubre fuentes de EPG gratuitas y arma epg_sources_catalog.json.

Recorre los proveedores públicos conocidos, prueba cada archivo y lo clasifica:

- **fresh**: tiene programación en las próximas 24 h;
- **stale**: responde, pero su programación es vieja (repos abandonados, rippers caídos);
- **down**: no se pudo bajar o no es un XMLTV válido.

Proveedores:
- epgshare01.online: lee el índice del directorio (todos sus `epg_ripper_*.xml.gz`).
- open-epg.com: prueba `<país>`, `<país>1`, `<país>2`… por cada país de COUNTRIES.
- iptv-epg.org: prueba `epg-<código>.xml.gz` por cada país.
- EXTRA_SOURCES: repos sueltos ya conocidos (acidjesuz, davidmuma, programadorx…).

Uso: `python tools/discover_epg_sources.py [--out epg_sources_catalog.json] [--only epgshare,openepg]`.
Lo corre una vez por semana `.github/workflows/discover-sources.yml`.
"""
import argparse
import datetime
import gzip
import json
import os
import re
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

import requests
from lxml import etree

CATALOG_PATH = 'epg_sources_catalog.json'
TIMEOUT = 60
MAX_BYTES = 200 * 1024 * 1024  # un archivo más grande que esto no se evalúa (ej. ALL_SOURCES)
WORKERS = 8
WINDOW = datetime.timedelta(hours=24)
USER_AGENT = 'epg-merger-source-discovery (+https://github.com/luispied/epg-merger)'

EPGSHARE_INDEX = 'https://epgshare01.online/epgshare01/'
EPGSHARE_SKIP = {'ALL_SOURCES1', 'DUMMY_CHANNELS'}
OPENEPG_FILES = 'https://www.open-epg.com/files/{name}.xml.gz'
IPTVEPG_FILES = 'https://iptv-epg.org/files/epg-{cc}.xml.gz'
OPENEPG_MAX_PARTS = 15

# Código ISO (como lo usan los channel_id: ".ar", ".us") -> nombre de archivo en open-epg.
COUNTRIES = {
    'ar': 'argentina', 'bo': 'bolivia', 'br': 'brazil', 'cl': 'chile', 'co': 'colombia',
    'cr': 'costarica', 'cu': 'cuba', 'do': 'dominicanrepublic', 'ec': 'ecuador', 'sv': 'elsalvador',
    'gt': 'guatemala', 'hn': 'honduras', 'mx': 'mexico', 'ni': 'nicaragua', 'pa': 'panama',
    'py': 'paraguay', 'pe': 'peru', 'pr': 'puertorico', 'uy': 'uruguay', 've': 'venezuela',
    'jm': 'jamaica', 'tt': 'trinidad', 'ht': 'haiti', 'bs': 'bahamas', 'bb': 'barbados',
    'us': 'unitedstates', 'ca': 'canada',
    'uk': 'unitedkingdom', 'ie': 'ireland', 'es': 'spain', 'pt': 'portugal', 'fr': 'france',
    'it': 'italy', 'de': 'germany', 'at': 'austria', 'ch': 'switzerland', 'be': 'belgium',
    'nl': 'netherlands', 'lu': 'luxembourg', 'dk': 'denmark', 'se': 'sweden', 'no': 'norway',
    'fi': 'finland', 'is': 'iceland', 'pl': 'poland', 'cz': 'czechrepublic', 'sk': 'slovakia',
    'hu': 'hungary', 'ro': 'romania', 'bg': 'bulgaria', 'gr': 'greece', 'cy': 'cyprus',
    'mt': 'malta', 'hr': 'croatia', 'si': 'slovenia', 'rs': 'serbia', 'ba': 'bosnia',
    'mk': 'macedonia', 'al': 'albania', 'me': 'montenegro', 'lt': 'lithuania', 'lv': 'latvia',
    'ee': 'estonia', 'ua': 'ukraine', 'ru': 'russia', 'tr': 'turkey',
    'il': 'israel', 'ae': 'unitedarabemirates', 'sa': 'saudiarabia', 'qa': 'qatar',
    'kw': 'kuwait', 'bh': 'bahrain', 'om': 'oman', 'jo': 'jordan', 'lb': 'lebanon', 'iq': 'iraq',
    'ir': 'iran', 'eg': 'egypt', 'ma': 'morocco', 'dz': 'algeria', 'tn': 'tunisia',
    'za': 'southafrica', 'ng': 'nigeria', 'ke': 'kenya', 'gh': 'ghana',
    'in': 'india', 'pk': 'pakistan', 'bd': 'bangladesh', 'lk': 'srilanka', 'cn': 'china',
    'hk': 'hongkong', 'tw': 'taiwan', 'jp': 'japan', 'kr': 'southkorea', 'ph': 'philippines',
    'id': 'indonesia', 'my': 'malaysia', 'sg': 'singapore', 'th': 'thailand', 'vn': 'vietnam',
    'au': 'australia', 'nz': 'newzealand', 'kz': 'kazakhstan', 'mn': 'mongolia',
}
# Archivos de open-epg que no son de un país.
OPENEPG_THEMES = ['sports', 'music', 'news', 'movies', 'kids']

# Repos sueltos: ya conocidos, se re-evalúan igual que los demás.
EXTRA_SOURCES = [
    {'id': 'acidjesuz-us', 'provider': 'acidjesuz', 'country': 'us',
     'url': 'https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/US_guide.xml.gz'},
    {'id': 'acidjesuz-us-local', 'provider': 'acidjesuz', 'country': 'us',
     'url': 'https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/US_local_guide.xml.gz'},
    {'id': 'acidjesuz-latino', 'provider': 'acidjesuz', 'country': None,
     'url': 'https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/Latino_guide.xml.gz'},
    {'id': 'davidmuma-es', 'provider': 'davidmuma', 'country': 'es',
     'url': 'https://raw.githubusercontent.com/davidmuma/EPG_dobleM/master/guiatv_sincolor.xml.gz'},
    {'id': 'programadorx-cl', 'provider': 'programadorx', 'country': 'cl',
     'url': 'https://epg.programadorx.cl/mdiaz/gratis.xml'},
    # Evaluadas el 27/09/2026 y abandonadas en ese momento: quedan para detectar si reviven.
    {'id': 'globetv-venezuela1', 'provider': 'globetvapp', 'country': 've',
     'url': 'https://raw.githubusercontent.com/globetvapp/epg/main/Venezuela/venezuela1.xml.gz'},
    {'id': 'iks66', 'provider': 'Mcarv00', 'country': None,
     'url': 'https://raw.githubusercontent.com/Mcarv00/IKS66EPG/master/freeiptv.xml'},
]

_session = requests.Session()
_session.headers['User-Agent'] = USER_AGENT


# ------------------------------------------------------------------ candidatos

def epgshare_candidates(index_html=None):
    """Todos los epg_ripper_*.xml.gz del índice. El país sale del prefijo (AR1 -> ar) si es un
    código conocido; los temáticos (BEIN1, PLEX1…) quedan sin país."""
    if index_html is None:
        index_html = _session.get(EPGSHARE_INDEX, timeout=TIMEOUT).text
    names = sorted(set(re.findall(r'epg_ripper_([A-Z0-9_]+)\.xml\.gz', index_html)))
    out = []
    for name in names:
        if name in EPGSHARE_SKIP:
            continue
        prefix = re.match(r'^([A-Z]{2})(?:\d|_|$)', name)
        cc = prefix.group(1).lower() if prefix else None
        if cc == 'gb':
            cc = 'uk'
        out.append({'id': f'epgshare-{name.lower()}', 'provider': 'epgshare01',
                    'country': cc if cc in COUNTRIES else None,
                    'url': f'{EPGSHARE_INDEX}epg_ripper_{name}.xml.gz'})
    return out


def _exists(url):
    """open-epg responde 200 con cuerpo vacío para archivos que no existen: hay que mirar
    que venga contenido, no solo el código."""
    try:
        with _session.get(url, timeout=TIMEOUT, stream=True) as r:
            if r.status_code != 200:
                return False
            return bool(next(r.iter_content(64), b''))
    except requests.RequestException:
        return False


def openepg_candidates(countries=COUNTRIES):
    """Por país prueba `<nombre>` y `<nombre>1..N` (se corta en el primer número que falta)."""
    def probe(item):
        cc, name = item
        found = []
        if _exists(OPENEPG_FILES.format(name=name)):
            found.append(name)
        for n in range(1, OPENEPG_MAX_PARTS + 1):
            if not _exists(OPENEPG_FILES.format(name=f'{name}{n}')):
                break
            found.append(f'{name}{n}')
        return [{'id': f'openepg-{f}', 'provider': 'open-epg', 'country': cc,
                 'url': OPENEPG_FILES.format(name=f).replace('://www.', '://')} for f in found]

    items = list(countries.items()) + [(None, t) for t in OPENEPG_THEMES]
    with ThreadPoolExecutor(WORKERS) as pool:
        return [c for group in pool.map(probe, items) for c in group]


def iptvepg_candidates(countries=COUNTRIES):
    def probe(cc):
        url = IPTVEPG_FILES.format(cc=cc)
        return {'id': f'iptvepg-{cc}', 'provider': 'iptv-epg.org', 'country': cc, 'url': url} \
            if _exists(url) else None

    with ThreadPoolExecutor(WORKERS) as pool:
        return [c for c in pool.map(probe, countries) if c]


# ------------------------------------------------------------------ evaluación

def evaluate_xmltv(stream, now=None):
    """Cuenta canales y programación de un XMLTV (file-like, sin comprimir) en streaming.
    `live_channels`: canales con al menos un programa en las próximas 24 h."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    lo = now.strftime('%Y%m%d%H%M%S')
    hi = (now + WINDOW).strftime('%Y%m%d%H%M%S')
    channels = 0
    programmes = 0
    live = set()
    last_start = ''
    for _, el in etree.iterparse(stream, events=('end',), tag=('channel', 'programme'),
                                 huge_tree=True, recover=True):
        if el.tag == 'channel':
            channels += 1
        else:
            programmes += 1
            # Comparación por texto en UTC aproximado: alcanza para "¿tiene algo en las
            # próximas 24 h?", no hace falta resolver el offset de cada programa.
            start = (el.get('start') or '')[:14]
            stop = (el.get('stop') or '')[:14]
            last_start = max(last_start, start)
            if start < hi and stop > lo:
                live.add(el.get('channel'))
        el.clear()
        while el.getprevious() is not None:
            del el.getparent()[0]
    return {'channels': channels, 'programmes': programmes, 'live_channels': len(live),
            'last_programme': last_start or None}


def check_source(source, now=None):
    """Baja la fuente a un temporal (sin pasar de MAX_BYTES) y la evalúa."""
    result = dict(source)
    result['last_checked'] = (now or datetime.datetime.now(datetime.timezone.utc)).strftime('%Y-%m-%dT%H:%MZ')
    try:
        with _session.get(source['url'], timeout=TIMEOUT, stream=True) as r:
            r.raise_for_status()
            with tempfile.TemporaryFile() as tmp:
                size = 0
                for chunk in r.iter_content(1 << 20):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError(f'más de {MAX_BYTES >> 20} MB')
                    tmp.write(chunk)
                tmp.seek(0)
                head = tmp.read(2)
                tmp.seek(0)
                stream = gzip.GzipFile(fileobj=tmp) if head == b'\x1f\x8b' else tmp
                stats = evaluate_xmltv(stream, now)
        result['size_bytes'] = size
        result.update(stats)
        result['status'] = 'fresh' if stats['live_channels'] else ('stale' if stats['channels'] else 'down')
    except Exception as e:  # noqa: BLE001 — cualquier falla deja la fuente como "down"
        result.update({'status': 'down', 'error': str(e)[:200]})
    return result


# ------------------------------------------------------------------ catálogo

def build_catalog(candidates, now=None):
    seen = {}
    for c in candidates:
        seen.setdefault(c['id'], c)
    with ThreadPoolExecutor(WORKERS) as pool:
        checked = list(pool.map(lambda c: check_source(c, now), seen.values()))
    checked.sort(key=lambda s: (s['country'] or '~', s['provider'], s['id']))
    counts = {}
    for s in checked:
        counts[s['status']] = counts.get(s['status'], 0) + 1
    return {
        '_comment': 'Generado por tools/discover_epg_sources.py. status: fresh (programación en las '
                    'próximas 24 h), stale (vieja) o down (no responde / no es XMLTV). epg_urls.json '
                    'puede referenciar estas fuentes por id.',
        'generated_at': (now or datetime.datetime.now(datetime.timezone.utc)).strftime('%Y-%m-%dT%H:%MZ'),
        'summary': counts,
        'sources': checked,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--out', default=CATALOG_PATH)
    parser.add_argument('--only', default='epgshare,openepg,iptvepg,extra',
                        help='proveedores a recorrer, separados por coma')
    args = parser.parse_args(argv)
    only = set(args.only.split(','))

    candidates = []
    if 'epgshare' in only:
        candidates += epgshare_candidates()
    if 'openepg' in only:
        candidates += openepg_candidates()
    if 'iptvepg' in only:
        candidates += iptvepg_candidates()
    if 'extra' in only:
        candidates += EXTRA_SOURCES
    print(f'🔎 {len(candidates)} fuentes candidatas; evaluando…', flush=True)

    catalog = build_catalog(candidates)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f"✅ {args.out}: {len(catalog['sources'])} fuentes {catalog['summary']}")
    return 0


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    sys.exit(main())
