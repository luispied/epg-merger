#!/usr/bin/env python3
import gzip
from pathlib import Path

import requests
from lxml import etree

EPG_URLS = [
    "https://epgshare01.online/epgshare01/epg_ripper_ES1.xml.gz",
    "https://open-epg.com/epg/es.xml",
    # Agrega aquí el resto de tus URLs EPG.
]

OUTPUT_PATH = Path("merged.xml.gz")


def download_epg(url):
    """Descarga un EPG (soporta .gz)."""
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        if url.endswith(".gz"):
            return gzip.decompress(response.content)
        return response.content
    except Exception as exc:
        print(f"Error descargando {url}: {exc}")
        return None


def merge_epgs():
    """Mergea múltiples EPGs en uno solo."""
    root = etree.Element("tv")
    channels = {}
    programmes = []

    for url in EPG_URLS:
        print(f"Descargando {url}...")
        data = download_epg(url)
        if not data:
            continue

        try:
            tree = etree.fromstring(data)
            for channel in tree.findall("channel"):
                channel_id = channel.get("id")
                if channel_id and channel_id not in channels:
                    channels[channel_id] = channel

            for programme in tree.findall("programme"):
                programmes.append(programme)
        except Exception as exc:
            print(f"Error parseando {url}: {exc}")

    for channel in channels.values():
        root.append(channel)

    for programme in programmes:
        root.append(programme)

    output = etree.tostring(
        root,
        encoding="utf-8",
        xml_declaration=True,
        pretty_print=True,
    )

    with gzip.open(OUTPUT_PATH, "wb") as output_file:
        output_file.write(output)

    print(f"✅ EPG mergeado exitosamente: {OUTPUT_PATH}")
    print(f"📊 Canales: {len(channels)}, Programas: {len(programmes)}")


if __name__ == "__main__":
    merge_epgs()
