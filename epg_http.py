#!/usr/bin/env python3
"""Descarga de fuentes EPG, compartida entre merge_epgs.py y generate_playlist.py."""
import gzip

import requests

# generate_playlist.py necesita esta fuente EPG específica para matchear la sección ENGLISH.
# Ya es una de las URLs de epg_urls.json, así que merge_epgs.py la cachea acá tal cual se
# descarga (evita duplicar ~15MB de descarga en cada corrida). Viven en este módulo neutral,
# no en merge_epgs.py ni generate_playlist.py, porque ambos scripts dependen del contrato.
PRIORITY_EPG_URL = 'https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/US_guide.xml.gz'
PRIORITY_EPG_CACHE_PATH = 'priority_us_epg_cache.xml'


def download_epg(url, timeout=10):
    """Descarga una fuente EPG (soporta .gz) y la devuelve descomprimida. None si falla."""
    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
        if url.endswith('.gz'):
            return gzip.decompress(response.content)
        return response.content
    except Exception as e:
        print(f"❌ Error descargando {url}: {e}")
        return None
