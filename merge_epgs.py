#!/usr/bin/env python3
import gzip
import json
import os
from lxml import etree
from collections import defaultdict

from epg_http import PRIORITY_EPG_CACHE_PATH, PRIORITY_EPG_URL, download_epg


def load_epg_urls():
    """Carga URLs desde epg_urls.json"""
    try:
        with open('epg_urls.json', 'r') as f:
            config = json.load(f)
            urls = config.get('urls', [])
            return [u for u in urls if not u.lstrip().startswith('#')]
    except FileNotFoundError:
        print("❌ Error: epg_urls.json no encontrado")
        return []
    except json.JSONDecodeError:
        print("❌ Error: epg_urls.json inválido")
        return []


def merge_epgs():
    """Mergea múltiples EPGs eliminando duplicados con data válida"""

    # Carga URLs
    EPG_URLS = load_epg_urls()

    if not EPG_URLS:
        print("❌ No hay URLs para procesar")
        return

    print(f"📋 Encontradas {len(EPG_URLS)} URLs de EPG")
    print("-" * 60)

    # Si la fuente prioritaria quedó deshabilitada (comentada en epg_urls.json), no la vamos a
    # descargar en este loop — se borra cualquier caché vieja para que generate_playlist.py no
    # reutilice datos obsoletos de una corrida anterior en la que sí estaba activa.
    if PRIORITY_EPG_URL not in EPG_URLS and os.path.exists(PRIORITY_EPG_CACHE_PATH):
        os.remove(PRIORITY_EPG_CACHE_PATH)

    root = etree.Element('tv', attrib={
        'generator-info-name': 'epg-merger',
        'generator-info-url': 'https://github.com/luispied/epg-merger',
    })
    channels = {}
    all_programmes = []
    programmes_by_channel = defaultdict(list)

    # Descarga y procesa cada EPG
    for url_index, url in enumerate(EPG_URLS):
        print(f"📥 [{url_index + 1}/{len(EPG_URLS)}] {url[:60]}...")
        data = download_epg(url)

        if not data:
            continue

        if url == PRIORITY_EPG_URL:
            try:
                with open(PRIORITY_EPG_CACHE_PATH, 'wb') as f:
                    f.write(data)
            except OSError as e:
                # No debe interrumpir el merge de las demás fuentes: generate_playlist.py
                # simplemente descargará esta URL de nuevo si la caché no quedó escrita.
                print(f"⚠️  No se pudo cachear la fuente prioritaria: {e}")

        try:
            tree = etree.fromstring(data)

            # Recolecta canales
            for channel in tree.findall('channel'):
                channel_id = channel.get('id')
                if not channel_id:
                    continue

                # Entre duplicados, se queda con la versión de la fuente más prioritaria
                # (url_index más bajo). El conteo de programas se calcula después, en un
                # solo lugar, para no arrastrar un valor que acá siempre sería 0.
                if channel_id not in channels or url_index < channels[channel_id][1]:
                    channels[channel_id] = (channel, url_index)

            # Recolecta programas
            for programme in tree.findall('programme'):
                channel_id = programme.get('channel')
                programmes_by_channel[channel_id].append(programme)
                all_programmes.append(programme)

        except Exception as e:
            print(f"❌ Error parseando: {e}")
            continue

    # Filtra canales válidos (con data)
    valid_channels = {
        cid: channel_elem
        for cid, (channel_elem, _) in channels.items()
        if len(programmes_by_channel.get(cid, [])) > 0
    }

    duplicados_eliminados = len(channels) - len(valid_channels)

    print("\n" + "-" * 60)
    print("📊 ESTADÍSTICAS:")
    print(f"   URLs procesadas: {len(EPG_URLS)}")
    print(f"   Canales encontrados: {len(channels)}")
    print(f"   Canales con data: {len(valid_channels)}")
    print(f"   Duplicados eliminados: {duplicados_eliminados}")
    print(f"   Programas totales: {len(all_programmes)}")
    print("-" * 60)

    # Construye XML final
    for channel_id, channel_elem in sorted(valid_channels.items()):
        root.append(channel_elem)

    # Agrega programas de canales válidos
    valid_channel_ids = set(valid_channels.keys())
    for programme in all_programmes:
        if programme.get('channel') in valid_channel_ids:
            root.append(programme)

    # Guarda comprimido
    body = etree.tostring(root, encoding='utf-8', xml_declaration=False, pretty_print=True)
    output = b'<?xml version="1.0" encoding="UTF-8" ?>\n' + body

    with gzip.open('merged.xml.gz', 'wb') as f:
        f.write(output)

    print(f"\n✅ EPG generado exitosamente!")
    print(f"📁 merged.xml.gz ({len(output) / 1024 / 1024:.2f} MB)")


if __name__ == "__main__":
    merge_epgs()
