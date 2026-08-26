#!/usr/bin/env python3
"""Descarga de fuentes EPG."""
import gzip
from concurrent.futures import ThreadPoolExecutor

import requests

# Descargas simultáneas. El cuello de botella es la red, no la CPU, pero cada archivo pesa
# decenas de MB descomprimido: se descargan de a tandas para no tener más de estos en memoria
# a la vez esperando a que el merge los consuma.
DEFAULT_WORKERS = 6


def download_epg(url, timeout=60):
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


def download_all(urls, workers=DEFAULT_WORKERS, timeout=60):
    """Descarga las URLs en tandas paralelas, entregando (url, datos) en el orden pedido.

    No se cachea con ETag a propósito: el workflow corre una vez por día y las fuentes se
    actualizan a diario, así que casi nunca habría un 304 que aprovechar. Lo que sí paga es
    el paralelismo, porque las descargas son casi todo tiempo de espera.
    """
    urls = list(urls)
    for start in range(0, len(urls), workers):
        batch = urls[start:start + workers]
        with ThreadPoolExecutor(max_workers=workers) as pool:
            data = list(pool.map(lambda u: download_epg(u, timeout), batch))
        for url, payload in zip(batch, data):
            yield url, payload
