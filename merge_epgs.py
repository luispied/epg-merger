#!/usr/bin/env python3
import requests
import gzip
import io
import json
from lxml import etree
from datetime import datetime
from pathlib import Path
from collections import defaultdict

EPG_URLS_PATH = Path(__file__).with_name("epg_urls.json")


def load_epg_urls():
    with EPG_URLS_PATH.open("r", encoding="utf-8") as f:
        urls = json.load(f)
    if not isinstance(urls, list) or not all(isinstance(url, str) for url in urls):
        raise ValueError("epg_urls.json debe contener una lista de URLs")
    return urls


EPG_URLS = load_epg_urls()

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
    root = etree.Element('tv')
    channels = {}  # {channel_id: (channel_element, program_count, url_index)}
    all_programmes = []
    programmes_by_channel = defaultdict(list)
    
    # Descarga y procesa cada EPG
    for url_index, url in enumerate(EPG_URLS):
        print(f"📥 [{url_index + 1}/{len(EPG_URLS)}] Descargando {url}...")
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
                
                # Si ya existe este canal, compara data
                if channel_id in channels:
                    existing_channel, existing_count, existing_index = channels[channel_id]
                    # Mantén el que venga de URL con mayor prioridad (menor index)
                    if url_index < existing_index:
                        channels[channel_id] = (channel, existing_count, url_index)
                else:
                    channels[channel_id] = (channel, 0, url_index)
            
            # Recolecta programas y cuenta por canal
            for programme in tree.findall('programme'):
                channel_id = programme.get('channel')
                programmes_by_channel[channel_id].append(programme)
                all_programmes.append(programme)
                
        except Exception as e:
            print(f"❌ Error parseando {url}: {e}")
            continue
    
    # Actualiza contador de programas por canal
    for channel_id in channels:
        channel_elem, _, url_index = channels[channel_id]
        program_count = len(programmes_by_channel.get(channel_id, []))
        channels[channel_id] = (channel_elem, program_count, url_index)
    
    # Filtra canales sin data
    valid_channels = {
        cid: (ch, count, idx) 
        for cid, (ch, count, idx) in channels.items() 
        if count > 0
    }
    
    print(f"\n📊 Estadísticas:")
    print(f"   Canales totales encontrados: {len(channels)}")
    print(f"   Canales con data válida: {len(valid_channels)}")
    print(f"   Canales sin programas (excluidos): {len(channels) - len(valid_channels)}")
    print(f"   Programas totales: {len(all_programmes)}")
    
    # Construye XML final
    for channel_id, (channel_elem, count, _) in sorted(valid_channels.items()):
        root.append(channel_elem)
    
    # Agrega solo programas de canales válidos
    valid_channel_ids = set(valid_channels.keys())
    for programme in all_programmes:
        if programme.get('channel') in valid_channel_ids:
            root.append(programme)
    
    # Guarda resultado comprimido
    output = etree.tostring(root, encoding='utf-8', xml_declaration=True, pretty_print=True)
    
    with gzip.open('merged.xml.gz', 'wb') as f:
        f.write(output)
    
    print(f"\n✅ EPG mergead exitosamente!")
    print(f"📁 Archivo: merged.xml.gz")
    print(f"🔗 URL: https://luispied.github.io/epg-merger/merged.xml.gz")

if __name__ == "__main__":
    merge_epgs()
