"""Lo que sale del repo (guía de Grilla web y XML de los reproductores) no nombra las fuentes de EPG:

- `source_alias(id)`: alias opaco y estable de una fuente, `s` + 8 caracteres de un hash del id. La
  corrida y el matcher de Python siguen con los ids reales; la web traduce con la misma fórmula los
  `prefer_sources` de cada configuración (`sourceAlias` en worker/src/crypto.ts).
- `logo_key(url)`: los logos de la guía se piden al Worker (`/logo/<clave>`), que los baja una vez,
  los guarda en R2 y los sirve; quien mira no ve de qué sitio vienen. El Worker resuelve la clave con
  `logo/map.json` (privado en R2, lo sube tools/r2_upload.sh); la misma fórmula está en
  `logoKey` de worker/src/logos.ts.
"""
import hashlib
import os

DEFAULT_WORKER = 'https://grilla.grilla.workers.dev'


def source_alias(source_id):
    if not source_id:
        return source_id
    return 's' + hashlib.sha256(f'grilla-fuente\n{source_id}'.encode('utf-8')).hexdigest()[:8]


def logo_key(url):
    return hashlib.sha256(f'grilla-logo\n{url}'.encode('utf-8')).hexdigest()[:16]


def logo_path(url):
    """Ruta en el Worker del logo (relativa: la usa la web, que está en el mismo origen)."""
    return f'/logo/{logo_key(url)}' if url else url


def worker_url():
    return (os.environ.get('GRILLA_WORKER') or DEFAULT_WORKER).rstrip('/')
