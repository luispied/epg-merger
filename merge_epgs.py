#!/usr/bin/env python3
"""Descarga las fuentes EPG configuradas y las fusiona en merged.xml.gz.

Cada canal del XML resultante lleva un atributo `source` con el id de la fuente de la que
salió, para que generate_playlist.py pueda preferir fuentes concretas por sección sin tener
que volver a descargar ni re-parsear nada. XMLTV ignora los atributos desconocidos, así que
los reproductores no se ven afectados.
"""
import gzip
import json
import os

from lxml import etree

from epg_http import download_all

SOURCES_PATH = 'epg_urls.json'
OUTPUT_PATH = 'merged.xml.gz'


def _source_id_from_url(url):
    """'.../epg_ripper_AR1.xml.gz' -> 'epg_ripper_AR1' (id estable derivado del nombre de archivo)."""
    base = url.rstrip('/').split('/')[-1].split('?')[0]
    return base.split('.')[0] or url


def load_sources(path=SOURCES_PATH):
    """Carga las fuentes EPG desde epg_urls.json.

    Acepta el formato nuevo ("sources": lista de objetos con id/url/country/priority) y el
    viejo ("urls": lista de strings), donde el id se deriva del nombre de archivo. En ambos,
    'priority' por defecto es la posición en el archivo — o sea que sin declarar prioridades
    el comportamiento es el de siempre: gana la fuente que aparece primero. Menor = mejor.
    """
    try:
        with open(path, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except FileNotFoundError:
        print(f"❌ Error: {path} no encontrado")
        return []
    except json.JSONDecodeError as e:
        print(f"❌ Error: {path} inválido ({e})")
        return []

    raw = config.get('sources')
    if raw is None:
        raw = config.get('urls', [])

    sources = []
    seen_ids = set()
    for i, entry in enumerate(raw):
        if isinstance(entry, str):
            entry = {'url': entry}
        url = (entry.get('url') or '').strip()
        if not url or url.startswith('#'):  # convención para deshabilitar una fuente sin borrarla
            continue
        source_id = entry.get('id') or _source_id_from_url(url)
        if source_id in seen_ids:
            # Dos fuentes no pueden compartir id: el atributo `source` del canal dejaría de
            # identificar de dónde salió realmente.
            source_id = f"{source_id}-{i}"
        seen_ids.add(source_id)
        sources.append({
            'id': source_id,
            'url': url,
            'country': entry.get('country'),
            'priority': entry.get('priority', i),
        })
    return sources


def merge_epgs():
    sources = load_sources()
    if not sources:
        print("❌ No hay fuentes para procesar")
        return

    print(f"📋 Encontradas {len(sources)} fuentes de EPG")
    print("-" * 60)

    root = etree.Element('tv', attrib={
        'generator-info-name': 'epg-merger',
        'generator-info-url': 'https://github.com/luispied/epg-merger',
    })
    channels = {}              # channel_id -> (elemento, rango)
    programmes = {}            # channel_id -> {start: (rango, elemento)}
    dropped_duplicates = 0

    downloads = download_all([s['url'] for s in sources])
    for n, (source, (_, data)) in enumerate(zip(sources, downloads), 1):
        print(f"📥 [{n}/{len(sources)}] {source['id']}: {source['url'][:60]}...")
        if not data:
            continue

        try:
            tree = etree.fromstring(data)
        except Exception as e:
            print(f"❌ Error parseando: {e}")
            continue

        # La posición en el archivo desempata cuando dos fuentes declaran la misma 'priority',
        # para que el resultado no dependa de cuál terminó de descargarse primero.
        rank = (source['priority'], n)

        for channel in tree.findall('channel'):
            channel_id = channel.get('id')
            if not channel_id:
                continue
            # Entre duplicados gana la fuente más prioritaria, y el canal queda estampado con
            # el id de esa fuente.
            if channel_id not in channels or rank < channels[channel_id][1]:
                channel.set('source', source['id'])
                channels[channel_id] = (channel, rank)

        # Los programas se deduplican por (canal, start): sin esto, un canal presente en las 7
        # fuentes de España termina con su programación repetida 7 veces y solapada en el
        # tiempo. Se deduplica por `start` en vez de por (start, stop) porque distintas fuentes
        # suelen diferir en el `stop` del mismo programa. Un canal solo puede tener un programa
        # empezando a una hora dada, así que ante colisión gana la fuente más prioritaria; los
        # horarios que la fuente ganadora no cubre los siguen aportando las demás, para no
        # perder días de guía al deduplicar.
        for programme in tree.findall('programme'):
            channel_id = programme.get('channel')
            start = programme.get('start')
            if not channel_id or not start:
                continue
            slots = programmes.setdefault(channel_id, {})
            existing = slots.get(start)
            if existing is None:
                slots[start] = (rank, programme)
            else:
                dropped_duplicates += 1
                if rank < existing[0]:
                    slots[start] = (rank, programme)

    # Un canal sin ningún programa no sirve de nada en la guía.
    valid_channels = {cid: elem for cid, (elem, _) in channels.items() if programmes.get(cid)}

    total_programas = sum(len(s) for cid, s in programmes.items() if cid in valid_channels)

    print("\n" + "-" * 60)
    print("📊 ESTADÍSTICAS:")
    print(f"   Fuentes procesadas: {len(sources)}")
    print(f"   Canales encontrados: {len(channels)}")
    print(f"   Canales con data: {len(valid_channels)}")
    print(f"   Canales sin programación: {len(channels) - len(valid_channels)}")
    print(f"   Programas totales: {total_programas}")
    print(f"   Programas duplicados descartados: {dropped_duplicates}")
    print("-" * 60)

    for channel_id, channel_elem in sorted(valid_channels.items()):
        root.append(channel_elem)

    for channel_id in sorted(valid_channels):
        for start in sorted(programmes[channel_id]):
            root.append(programmes[channel_id][start][1])

    body = etree.tostring(root, encoding='utf-8', xml_declaration=False, pretty_print=True)
    output = b'<?xml version="1.0" encoding="UTF-8" ?>\n' + body

    with gzip.open(OUTPUT_PATH, 'wb') as f:
        f.write(output)

    print(f"\n✅ EPG generado exitosamente!")
    print(f"📁 {OUTPUT_PATH}: {os.path.getsize(OUTPUT_PATH) / 1024 / 1024:.1f} MB comprimido "
          f"({len(output) / 1024 / 1024:.0f} MB de XML)")


if __name__ == "__main__":
    merge_epgs()
