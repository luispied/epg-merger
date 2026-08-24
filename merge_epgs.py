#!/usr/bin/env python3
import requests
import gzip
import io
from lxml import etree
from datetime import datetime
from collections import defaultdict

# URLs EPG (en orden de prioridad)
EPG_URLS = [
    "https://epgshare01.online/epgshare01/epg_ripper_AR1.xml.gz",
    "https://open-epg.com/files/argentina.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_BEIN1.xml.gz",
    "https://open-epg.com/files/bolivia1.xml.gz",
    "https://open-epg.com/files/bolivia2.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz",
    "https://open-epg.com/files/canada.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_CA2.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_CL1.xml.gz",
    "https://open-epg.com/files/colombia1.xml.gz",
    "https://open-epg.com/files/colombia2.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_CR1.xml.gz",
    "https://open-epg.com/files/costarica1.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz",
    "https://open-epg.com/files/germany.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_DIRECTVSPORTS1.xml.gz",
    "https://epg.programadordx.cl/mdiaz/gratis.xml",
    "https://epgshare01.online/epgshare01/epg_ripper_EC1.xml.gz",
    "https://open-epg.com/files/ecuador1.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_ES1.xml.gz",
    "https://open-epg.com/files/spain1.xml.gz",
    "https://open-epg.com/files/spain2.xml.gz",
    "https://open-epg.com/files/spain3.xml.gz",
    "https://open-epg.com/files/spain4.xml.gz",
    "https://open-epg.com/files/spain5.xml.gz",
    "https://open-epg.com/files/spain6.xml.gz",
    "https://open-epg.com/files/spain7.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_FANDUEL1.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_IT1.xml.gz",
    "https://open-epg.com/files/italy1.xml.gz",
    "https://open-epg.com/files/italy2.xml.gz",
    "https://open-epg.com/files/italy3.xml.gz",
    "https://open-epg.com/files/italy4.xml.gz",
    "https://open-epg.com/files/italy5.xml.gz",
    "https://open-epg.com/files/italy6.xml.gz",
    "https://open-epg.com/files/italy7.xml.gz",
    "https://open-epg.com/files/italy8.xml.gz",
    "https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/Latino_guide.xml.gz",
    "https://raw.githubusercontent.com/davidmuma/EPG_dobleM/master/guiatv_sincolor.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_MX1.xml.gz",
    "https://open-epg.com/files/mexico1.xml.gz",
    "https://open-epg.com/files/mexico2.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_PA1.xml.gz",
    "https://open-epg.com/files/paraguay1.xml.gz",
    "https://open-epg.com/files/paraguay2.xml.gz",
    "https://open-epg.com/files/panama1.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_PE1.xml.gz",
    "https://open-epg.com/files/peru.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_PEACOCK1.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_PT1.xml.gz",
    "https://open-epg.com/files/portugal1.xml.gz",
    "https://open-epg.com/files/portugal2.xml.gz",
    "https://open-epg.com/files/sports1.xml.gz",
    "https://open-epg.com/files/sports4.xml.gz",
    "https://open-epg.com/files/sports5.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz",
    "https://open-epg.com/files/unitedkingdom.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz",
    "https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/US_local_guide.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_US_LOCALS1.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_US_SPORTS1.xml.gz",
    "https://open-epg.com/files/unitedstates1.xml.gz",
    "https://open-epg.com/files/unitedstates2.xml.gz",
    "https://open-epg.com/files/unitedstates3.xml.gz",
    "https://open-epg.com/files/unitedstates4.xml.gz",
    "https://open-epg.com/files/unitedstates5.xml.gz",
    "https://open-epg.com/files/unitedstates6.xml.gz",
    "https://open-epg.com/files/unitedstates7.xml.gz",
    "https://open-epg.com/files/unitedstates8.xml.gz",
    "https://open-epg.com/files/unitedstates9.xml.gz",
    "https://open-epg.com/files/unitedstates10.xml.gz",
    "https://open-epg.com/files/unitedstates11.xml.gz",
    "https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/US_guide.xml.gz",
    "https://open-epg.com/files/uruguay.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_UY1.xml.gz",
]

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
