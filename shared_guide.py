#!/usr/bin/env python3
"""Guía compartida para Grilla web (Etapa 1): lo que el navegador y el Worker necesitan de la
corrida diaria, en `out/shared/`, para subirlo a Cloudflare R2 (ver `tools/r2_upload.sh`).

- `guide/index.json`: los canales de la guía (id, fuente, nombres, logo), las fuentes (país,
  prioridad) y `matching_rules.json`. Sin rastro de las fuentes: alias opacos y logos por el
  Worker (`source_alias.py`). Es exactamente lo que `@grilla/core` (core/) necesita
  para hacer el matching en el navegador: `new EpgIndex(channels, new MatchingRules(rules),
  sources)`.

- `logo/map/*.json`, `img/map/*.json`: {clave: url} de los logos de canal y las imágenes de
  programa, privados, para que el Worker las sirva sin mostrar el sitio.

La programación por canal (`out/schedule/`) ya la escribe `generate_playlist.py`; el script de
subida la empaca (`tools/pack_schedule.py`). Todo sube en gzip y solo si cambió (`tools/r2_sync.py`).

Uso: `python shared_guide.py [--merged merged.xml.gz] [--out out/shared]`.
"""
import argparse
import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from channel_names import RULES_PATH, parse_channel_name  # noqa: E402
from generate_playlist import MERGED_EPG_PATH, iter_programmes, load_epg_channels  # noqa: E402
from merge_epgs import load_sources  # noqa: E402
from source_alias import channel_alias, fold_key, logo_key, logo_path, media_urls, shard, source_alias  # noqa: E402

SHARED_DIR = os.path.join('out', 'shared')
INDEX_VERSION = 1


def guide_channels(root):
    """[{id, source, names, icon}] de los <channel> de la guía, en su orden (el desempate del
    matcher depende del orden: tiene que ser el mismo que ve Python)."""
    out = []
    for channel in root.findall('channel'):
        if not channel.get('id'):
            continue
        icon = channel.find('icon')
        out.append({'id': channel.get('id'), 'source': channel.get('source'),
                    'names': [dn.text for dn in channel.findall('display-name') if dn.text],
                    'icon': icon.get('src') if icon is not None else ''})
    return out


def source_info(sources):
    """{id: {country, priority}}: lo que usa EpgIndex de cada fuente (sin URLs)."""
    return {s['id']: {'country': s.get('country'), 'priority': s.get('priority', 0)} for s in sources}


def masked_channel(ch):
    """Un canal del índice sin rastros de la fuente: id con alias (más la clave del id plegado, para
    resolver el id de EPG de la lista, y la región que daba el id real), fuente con alias y logo por el Worker."""
    out = {'id': channel_alias(ch['id']), 'k': fold_key(ch['id']), 'source': source_alias(ch['source']),
           'names': ch['names'], 'icon': logo_path(ch['icon'])}
    region = parse_channel_name(ch['id']).region
    if region:
        out['region'] = region
    return out


def build_index(root, sources, rules, now=None):
    """El índice que se publica: las fuentes van con su alias y los logos por el Worker (source_alias.py)."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    channels = [masked_channel(ch) for ch in guide_channels(root)]
    return {
        'version': INDEX_VERSION,
        'generated_at': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'matching_rules': rules,
        'sources': {source_alias(k): v for k, v in source_info(sources).items()},
        'channels': channels,
    }


def media_maps(root, programmes=()):
    """{'logo': {clave: url}, 'img': {clave: url}}: los logos de canal y las imágenes de programa
    de la guía. Con esto el Worker resuelve /logo/<clave> e /img/<clave> (source_alias.py)."""
    maps = {'logo': {}, 'img': {}}
    for channel in root.findall('channel'):
        for url in media_urls(channel):
            maps['logo'][logo_key(url)] = url
    for programme in programmes:
        for url in media_urls(programme):
            maps['img'][logo_key(url)] = url
    return maps


def write_media_maps(maps, out_dir=SHARED_DIR):
    """Un archivo por prefijo de la clave (`logo/map/<x>.json`, `img/map/<xx>.json`): el Worker
    lee solo el que necesita. Devuelve las carpetas escritas."""
    dirs = []
    for kind, entries in maps.items():
        shards = {}
        for key, url in entries.items():
            shards.setdefault(shard(key, kind), {})[key] = url
        d = os.path.join(out_dir, kind, 'map')
        os.makedirs(d, exist_ok=True)
        for prefix, part in shards.items():
            with open(os.path.join(d, f'{prefix}.json'), 'w', encoding='utf-8') as f:
                json.dump(part, f, ensure_ascii=False, separators=(',', ':'))
        dirs.append(d)
    return dirs


def write_index(index, out_dir=SHARED_DIR):
    path = os.path.join(out_dir, 'guide', 'index.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--merged', default=MERGED_EPG_PATH)
    ap.add_argument('--out', default=SHARED_DIR)
    args = ap.parse_args(argv)

    with open(RULES_PATH, encoding='utf-8') as f:
        rules = json.load(f)
    root = load_epg_channels(args.merged)
    index = build_index(root, load_sources(), rules)
    path = write_index(index, args.out)
    maps = media_maps(root, iter_programmes(args.merged))
    write_media_maps(maps, args.out)
    print(f"🖼️  Imágenes por el Worker: {len(maps['logo'])} logos de canal, {len(maps['img'])} de programas")
    print(f"🌐 {path}: {len(index['channels'])} canales, {len(index['sources'])} fuentes "
          f"({os.path.getsize(path) / 1024 / 1024:.1f} MB)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
