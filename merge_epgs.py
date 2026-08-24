#!/usr/bin/env python3
import requests
import gzip
import json
from lxml import etree
from collections import defaultdict


def load_epg_urls():
    """Carga URLs desde epg_urls.json"""
    try:
        with open('epg_urls.json', 'r') as f:
            config = json.load(f)
            return config.get('urls', [])
    except FileNotFoundError:
        print("❌ Error: epg_urls.json no encontrado")
        return []
    except json.JSONDecodeError:
        print("❌ Error: epg_urls.json inválido")
        return []


def download_epg(url):
    """Descarga un EPG (soporta .gz)"""
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()

        if url.endswith('.gz'):
            return gzip.decompress(response.content)
        return response.content
    except Exception as e:
        print(f"❌ Error descargando {url}: {e}")
        return None


def merge_epgs():
    """Mergea múltiples EPGs eliminando duplicados con data válida"""

    # Carga URLs
    EPG_URLS = load_epg_urls()

    if not EPG_URLS:
        print("❌ No hay URLs para procesar")
        return

    print(f"📋 Encontradas {len(EPG_URLS)} URLs de EPG")
    print("-" * 60)

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

        try:
            tree = etree.fromstring(data)

            # Recolecta canales
            for channel in tree.findall('channel'):
                channel_id = channel.get('id')
                if not channel_id:
                    continue

                if channel_id in channels:
                    existing_channel, existing_count, existing_index = channels[channel_id]
                    if url_index < existing_index:
                        channels[channel_id] = (channel, existing_count, url_index)
                else:
                    channels[channel_id] = (channel, 0, url_index)

            # Recolecta programas
            for programme in tree.findall('programme'):
                channel_id = programme.get('channel')
                programmes_by_channel[channel_id].append(programme)
                all_programmes.append(programme)

        except Exception as e:
            print(f"❌ Error parseando: {e}")
            continue

    # Actualiza contador de programas
    for channel_id in channels:
        channel_elem, _, url_index = channels[channel_id]
        program_count = len(programmes_by_channel.get(channel_id, []))
        channels[channel_id] = (channel_elem, program_count, url_index)

    # Filtra canales válidos (con data)
    valid_channels = {
        cid: (ch, count, idx)
        for cid, (ch, count, idx) in channels.items()
        if count > 0
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
    for channel_id, (channel_elem, count, _) in sorted(valid_channels.items()):
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
