#!/usr/bin/env python3
"""Descarga las fuentes EPG configuradas y las fusiona en merged.xml.gz.

Cada canal del XML resultante lleva un atributo `source` con el id de la fuente de la que
salió, para que generate_playlist.py pueda preferir fuentes concretas por sección sin tener
que volver a descargar ni re-parsear nada. XMLTV ignora los atributos desconocidos, así que
los reproductores no se ven afectados.
"""
import gzip
import io
import json
import os
import shutil
import sqlite3
import tempfile

from lxml import etree

from epg_http import download_all

SOURCES_PATH = 'epg_urls.json'
OUTPUT_PATH = 'merged.xml.gz'

# Algunas fuentes (schedulesdirect.org, visto en "HBO Family", "Universal Kids", "NBC Sports
# Chicago"...) dejan el <channel> con su nombre real pero le rellenan cada franja con este
# placeholder cuando el feed que originaba la guía se dio de baja. El nombre sigue matcheando
# perfecto contra el canal real de Xtream, así que sin este filtro el canal queda con "EPG
# asignado" mostrando siempre el mismo texto en vez de programación — peor que no tener EPG.
DEAD_PROGRAMME_TITLES = {'channel no longer available'}


def _is_dead_programme(programme):
    return any(
        (title.text or '').strip().lower() in DEAD_PROGRAMME_TITLES
        for title in programme.findall('title')
    )


def _source_id_from_url(url):
    """'.../epg_ripper_AR1.xml.gz' -> 'epg_ripper_AR1' (id estable derivado del nombre de archivo)."""
    base = url.rstrip('/').split('/')[-1].split('?')[0]
    return base.split('.')[0] or url


CATALOG_PATH = 'epg_sources_catalog.json'


def load_catalog(path=CATALOG_PATH):
    """{id: fuente} de epg_sources_catalog.json (tools/discover_epg_sources.py). Vacío si no está."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return {s['id']: s for s in json.load(f).get('sources', []) if s.get('id') and s.get('url')}
    except (FileNotFoundError, json.JSONDecodeError, AttributeError):
        return {}


def load_sources(path=SOURCES_PATH, catalog_path=CATALOG_PATH):
    """Carga las fuentes EPG desde epg_urls.json.

    Acepta el formato nuevo ("sources": lista de objetos con id/url/country/priority) y el
    viejo ("urls": lista de strings), donde el id se deriva del nombre de archivo. En ambos,
    'priority' por defecto es la posición en el archivo — o sea que sin declarar prioridades
    el comportamiento es el de siempre: gana la fuente que aparece primero. Menor = mejor.
    Las fuentes con "active": false (o con la url comentada con '#') se saltean.
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
    catalog = None
    for i, entry in enumerate(raw):
        if isinstance(entry, str):
            entry = {'url': entry}
        # Una entrada puede ser solo {"id": "..."} de una fuente del catálogo: la URL y el país
        # salen de ahí (lo declarado en la entrada manda sobre el catálogo).
        if not entry.get('url') and entry.get('id'):
            if catalog is None:
                catalog = load_catalog(catalog_path)
            known = catalog.get(entry['id'])
            if not known:
                print(f"⚠️  Fuente {entry['id']!r} no está en {catalog_path}; se ignora")
                continue
            entry = {'country': known.get('country'), **entry, 'url': known['url']}
        url = (entry.get('url') or '').strip()
        if not url or url.startswith('#'):  # convención vieja para deshabilitar sin borrarla
            continue
        # "active": false marca una fuente inactiva (con "inactive_reason" explicando por qué):
        # no se descarga, pero queda en la lista con su configuración para reactivarla.
        if entry.get('active', True) is False:
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


def _iter_source(data):
    """(tag, elemento) de cada <channel> y <programme> de una fuente, en streaming: se libera
    cada elemento después de usarlo, así una fuente enorme no arma su árbol entero en memoria."""
    for _, el in etree.iterparse(io.BytesIO(data), events=('end',), tag=('channel', 'programme'),
                                 huge_tree=True):
        yield el.tag, el
        el.clear()
        parent = el.getparent()
        if parent is not None:
            while el.getprevious() is not None:
                del parent[0]


def _xml(el):
    return etree.tostring(el, encoding='utf-8', with_tail=False)


def merge_epgs(output_path=OUTPUT_PATH):
    """Fusiona las fuentes en merged.xml.gz.

    Todo se procesa en streaming y los programas se deduplican en una base SQLite temporal en
    disco, no en memoria: con ~3 M de programas (iptv-epg.org de EE.UU. sola trae 1,15 M) el
    merge en memoria pasaba los 16 GB del runner y la corrida moría sin aviso (28/09/2026).
    El resultado es el mismo que antes: canales ordenados por id y programas por canal y hora.
    """
    sources = load_sources()
    if not sources:
        print("❌ No hay fuentes para procesar")
        return

    print(f"📋 Encontradas {len(sources)} fuentes de EPG")
    print("-" * 60)

    tmpdir = tempfile.mkdtemp(prefix='epg-merge-')
    db = sqlite3.connect(os.path.join(tmpdir, 'merge.db'))
    db.executescript("""
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE channels (id TEXT PRIMARY KEY, prio INTEGER, pos INTEGER, xml BLOB);
        CREATE TABLE programmes (channel TEXT, start TEXT, prio INTEGER, pos INTEGER, dead INTEGER, xml BLOB,
                                 PRIMARY KEY (channel, start)) WITHOUT ROWID;
    """)
    # Entre duplicados gana la fuente más prioritaria: menor (priority, posición en el archivo).
    # La posición desempata cuando dos fuentes declaran la misma 'priority', para que el
    # resultado no dependa de cuál terminó de descargarse primero.
    upsert_channel = """
        INSERT INTO channels VALUES (?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET prio = excluded.prio, pos = excluded.pos, xml = excluded.xml
        WHERE (excluded.prio, excluded.pos) < (channels.prio, channels.pos)"""
    upsert_programme = """
        INSERT INTO programmes VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (channel, start) DO UPDATE SET prio = excluded.prio, pos = excluded.pos,
            dead = excluded.dead, xml = excluded.xml
        WHERE (excluded.prio, excluded.pos) < (programmes.prio, programmes.pos)"""

    total_rows = 0
    try:
        downloads = download_all([s['url'] for s in sources])
        for n, (source, (_, data)) in enumerate(zip(sources, downloads), 1):
            print(f"📥 [{n}/{len(sources)}] {source['id']}: {source['url'][:60]}...")
            if not data:
                continue
            prio = source['priority']
            channel_rows, programme_rows = [], []
            try:
                for tag, el in _iter_source(data):
                    if tag == 'channel':
                        channel_id = el.get('id')
                        if channel_id:
                            # El canal queda estampado con el id de la fuente de la que salió.
                            el.set('source', source['id'])
                            channel_rows.append((channel_id, prio, n, _xml(el)))
                        continue
                    # Los programas se deduplican por (canal, start): sin esto, un canal
                    # presente en las 7 fuentes de España termina con su programación repetida
                    # 7 veces. Se usa `start` y no (start, stop) porque distintas fuentes suelen
                    # diferir en el `stop` del mismo programa. Los horarios que la fuente
                    # ganadora no cubre los siguen aportando las demás.
                    channel_id = el.get('channel')
                    start = el.get('start')
                    if channel_id and start:
                        programme_rows.append((channel_id, start, prio, n,
                                               int(_is_dead_programme(el)), _xml(el)))
                        if len(programme_rows) >= 50000:
                            db.executemany(upsert_programme, programme_rows)
                            total_rows += len(programme_rows)
                            programme_rows = []
            except etree.XMLSyntaxError as e:
                # Un archivo cortado a la mitad: se conserva lo que se alcanzó a leer bien.
                print(f"❌ Error parseando: {e}")
            del data
            db.executemany(upsert_channel, channel_rows)
            db.executemany(upsert_programme, programme_rows)
            total_rows += len(programme_rows)
            db.commit()

        total_channels = db.execute('SELECT COUNT(*) FROM channels').fetchone()[0]
        kept_programmes = db.execute('SELECT COUNT(*) FROM programmes').fetchone()[0]
        # Un canal sin ningún programa no sirve de nada en la guía — y uno cuya programación
        # entera es el placeholder de "dado de baja" (ver DEAD_PROGRAMME_TITLES) tampoco:
        # mostrarlo como si tuviera EPG es peor que dejarlo sin EPG.
        db.executescript("""
            CREATE TEMP TABLE valid AS
                SELECT channel AS id FROM programmes GROUP BY channel HAVING MIN(dead) = 0;
            CREATE TEMP TABLE dead AS
                SELECT channel AS id FROM programmes GROUP BY channel HAVING MIN(dead) = 1;
        """)
        valid = db.execute('SELECT COUNT(*) FROM channels WHERE id IN (SELECT id FROM valid)').fetchone()[0]
        dead_channels = db.execute('SELECT COUNT(*) FROM channels WHERE id IN (SELECT id FROM dead)').fetchone()[0]
        total_programas = db.execute(
            'SELECT COUNT(*) FROM programmes WHERE channel IN '
            '(SELECT id FROM valid WHERE id IN (SELECT id FROM channels))').fetchone()[0]

        print("\n" + "-" * 60)
        print("📊 ESTADÍSTICAS:")
        print(f"   Fuentes procesadas: {len(sources)}")
        print(f"   Canales encontrados: {total_channels}")
        print(f"   Canales con data: {valid}")
        print(f"   Canales sin programación: {total_channels - valid - dead_channels}")
        print(f"   Canales dados de baja por la fuente (solo placeholder): {dead_channels}")
        print(f"   Programas totales: {total_programas}")
        print(f"   Programas duplicados descartados: {total_rows - kept_programmes}")
        print("-" * 60)

        # Todos los canales antes que el primer programa: generate_playlist.load_epg_channels
        # corta la lectura ahí.
        raw_size = 0
        with gzip.open(output_path, 'wb') as out:
            def write(chunk):
                nonlocal raw_size
                raw_size += len(chunk)
                out.write(chunk)

            write(b'<?xml version="1.0" encoding="UTF-8" ?>\n'
                  b'<tv generator-info-name="epg-merger" '
                  b'generator-info-url="https://github.com/luispied/epg-merger">\n')
            for (xml,) in db.execute(
                    'SELECT xml FROM channels WHERE id IN (SELECT id FROM valid) ORDER BY id'):
                write(b'  ' + xml + b'\n')
            for (xml,) in db.execute(
                    'SELECT p.xml FROM programmes p JOIN channels c ON c.id = p.channel '
                    'WHERE p.channel IN (SELECT id FROM valid) ORDER BY p.channel, p.start'):
                write(b'  ' + xml + b'\n')
            write(b'</tv>\n')
    finally:
        db.close()
        shutil.rmtree(tmpdir, ignore_errors=True)

    print(f"\n✅ EPG generado exitosamente!")
    print(f"📁 {output_path}: {os.path.getsize(output_path) / 1024 / 1024:.1f} MB comprimido "
          f"({raw_size / 1024 / 1024:.0f} MB de XML)")


if __name__ == "__main__":
    merge_epgs()
