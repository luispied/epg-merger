#!/usr/bin/env python3
"""Descarga de fuentes EPG, compartida entre merge_epgs.py y generate_playlist.py."""
import gzip

import requests


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
