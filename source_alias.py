"""Lo que sale del repo (guía de Grilla web, programación de la interfaz y XML de los reproductores)
no deja rastro de las fuentes de EPG. Regla genérica, para cualquier fuente:

- `source_alias(id)`: alias opaco y estable de una fuente, `s` + 8 caracteres de un hash del id. La
  corrida y el matcher de Python siguen con los ids reales; la web traduce con la misma fórmula los
  `prefer_sources` de cada configuración (`sourceAlias` en worker/src/crypto.ts).
- Imágenes: todo `<icon>`/`<image>` se pide al Worker, que lo baja de su sitio sin que quien mira
  sepa cuál es. Logos de canal en `/logo/<clave>` (el Worker los guarda en R2), imágenes de
  programa en `/img/<clave>` (de paso, sin guardar). El Worker resuelve la clave con los mapas
  privados `logo/map/<x>.json` e `img/map/<xx>.json` de R2 (los arma shared_guide.py, los sube
  tools/r2_upload.sh). Misma fórmula que `mediaKey` de worker/src/logos.ts.
- `channel_alias(id)`: los ids de canal de la guía salen con un alias opaco (`g` + 14 hex + el sufijo
  de país si lo hay, que usa el matcher); `fold_key(id)` deja encontrar en esa guía el id de EPG que
  trae la lista del proveedor. Misma fórmula que core/src/alias.ts. Las configuraciones guardadas con
  el id real se traducen al leerlas (la fórmula sobre un alias da el mismo alias).
- `<url>` de canales y programas (el sitio de donde salió la guía) se saca.
- En títulos y descripciones se sacan los links a sitios de las fuentes (dominios de
  `epg_urls.json`, p. ej. "https://<fuente>/help" que algunas meten como descripción).
"""
import functools
import hashlib
import os
import re

DEFAULT_WORKER = 'https://grilla.grilla.workers.dev'
# Caracteres de hex de la clave que eligen el archivo del mapa: pocos logos de canal (el Worker
# los lee al armar cada playlist), muchas imágenes de programa (se lee uno por imagen).
MAP_SHARD = {'logo': 1, 'img': 2}
URL_RE = re.compile(r'https?://[^\s<>"]+', re.I)
TEXT_TAGS = ('title', 'sub-title', 'desc')
ALIAS_RE = re.compile(r'^g[0-9a-f]{14}(\.[a-z]{2})?$')
SUFFIX_RE = re.compile(r'\.([a-z]{2})$')
M32 = 0xFFFFFFFF


def _imul(a, b):
    return (a * b) & M32


def cyrb53(text, seed=0):
    """cyrb53 sobre unidades UTF-16, igual que en core/src/alias.ts."""
    h1, h2 = (0xdeadbeef ^ seed) & M32, (0x41c6ce57 ^ seed) & M32
    data = text.encode('utf-16-le')
    for i in range(0, len(data), 2):
        ch = data[i] | (data[i + 1] << 8)
        h1 = _imul(h1 ^ ch, 2654435761)
        h2 = _imul(h2 ^ ch, 1597334677)
    h1 = _imul(h1 ^ (h1 >> 16), 2246822507)
    h1 ^= _imul(h2 ^ (h2 >> 13), 3266489909)
    h2 = _imul(h2 ^ (h2 >> 16), 2246822507)
    h2 ^= _imul(h1 ^ (h1 >> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + h1


def _hex14(text):
    return format(cyrb53(f'grilla-canal\n{text}'), 'x').rjust(14, '0')


def is_channel_alias(channel_id):
    return bool(ALIAS_RE.match(channel_id or ''))


def channel_alias(channel_id):
    if not channel_id or is_channel_alias(channel_id):
        return channel_id
    m = SUFFIX_RE.search(channel_id)
    return 'g' + _hex14(channel_id) + (f'.{m.group(1)}' if m else '')


def fold_key(channel_id):
    return _hex14(re.sub(r'\s+', '', channel_id).lower())


def source_alias(source_id):
    if not source_id:
        return source_id
    return 's' + hashlib.sha256(f'grilla-fuente\n{source_id}'.encode('utf-8')).hexdigest()[:8]


def logo_key(url):
    return hashlib.sha256(f'grilla-logo\n{url}'.encode('utf-8')).hexdigest()[:16]


def logo_path(url, kind='logo'):
    """Ruta en el Worker de la imagen (relativa: la usa la web, que está en el mismo origen)."""
    return f'/{kind}/{logo_key(url)}' if url else url


def worker_url():
    return (os.environ.get('GRILLA_WORKER') or DEFAULT_WORKER).rstrip('/')


def shard(key, kind):
    return key[:MAP_SHARD[kind]]


def _site(host):
    """'images.open-epg.com' -> 'open-epg.com' (alcanza para las fuentes que usamos)."""
    return '.'.join(host.lower().split('.')[-2:])


@functools.lru_cache(maxsize=1)
def source_sites():
    """Sitios de las fuentes de EPG activas y de todo el catálogo (de sus URLs): una fuente
    automática (tools/auto_sources.py) puede entrar en la guía sin estar en epg_urls.json."""
    from merge_epgs import load_catalog, load_sources  # tarde: merge_epgs no hace falta para lo demás
    sites = set()
    for s in [*load_sources(), *load_catalog().values()]:
        m = re.match(r'https?://([^/:]+)', s.get('url') or '', re.I)
        if m:
            sites.add(_site(m.group(1)))
    return frozenset(sites)


def scrub_text(text, sites=None):
    """El texto sin los links a sitios de las fuentes."""
    if not text or '://' not in text:
        return text
    sites = source_sites() if sites is None else sites

    def drop(m):
        host = re.match(r'https?://([^/:?#]+)', m.group(0), re.I)
        return '' if host and _site(host.group(1)) in sites else m.group(0)
    out = URL_RE.sub(drop, text)
    return out if out == text else ' '.join(out.split())


def scrub_element(el, kind, sites=None):
    """Saca los rastros de la fuente de un <channel> (kind='logo') o <programme> (kind='img'),
    en el lugar. Se puede llamar más de una vez sobre el mismo elemento."""
    base = worker_url()
    for icon in el.iter('icon'):
        src = icon.get('src')
        if src and not src.startswith(base + '/'):
            icon.set('src', base + logo_path(src, kind))
    for image in el.iter('image'):
        src = (image.text or '').strip()
        if src and not src.startswith(base + '/'):
            image.text = base + logo_path(src, kind)
    for url in list(el.iter('url')):
        url.getparent().remove(url)
    for tag in TEXT_TAGS:
        for node in list(el.iter(tag)):
            text = scrub_text(node.text, sites)
            if text != node.text:
                if text or tag != 'desc':
                    node.text = text
                else:
                    node.getparent().remove(node)
    return el


def media_urls(el):
    """URLs de imagen de un <channel> o <programme> (lo que va a los mapas del Worker)."""
    urls = [icon.get('src') for icon in el.iter('icon') if icon.get('src')]
    urls += [(image.text or '').strip() for image in el.iter('image') if (image.text or '').strip()]
    return urls
