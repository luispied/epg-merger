#!/usr/bin/env python3
"""Guía compartida para Grilla web (Etapa 1): lo que el navegador y el Worker necesitan de la
corrida diaria, en `out/shared/`, para subirlo a Cloudflare R2 (ver `tools/r2_upload.sh`).

- `guide/index.json`: los canales de la guía (id, fuente, nombres, logo), las fuentes (país,
  prioridad) y `matching_rules.json`. Es exactamente lo que `@grilla/core` (core/) necesita
  para hacer el matching en el navegador: `new EpgIndex(channels, new MatchingRules(rules),
  sources)`.

La programación por canal y el catálogo para la interfaz (`out/schedule/`, `epg_catalog.json`,
`epg_icons.json`, `sources_report.json`) ya los escribe `generate_playlist.py`; el script de
subida los manda tal cual.

Uso: `python shared_guide.py [--merged merged.xml.gz] [--out out/shared]`.
"""
import argparse
import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from channel_names import RULES_PATH  # noqa: E402
from generate_playlist import MERGED_EPG_PATH, load_epg_channels  # noqa: E402
from merge_epgs import load_sources  # noqa: E402

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


def build_index(root, sources, rules, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    channels = guide_channels(root)
    return {
        'version': INDEX_VERSION,
        'generated_at': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'matching_rules': rules,
        'sources': source_info(sources),
        'channels': channels,
    }


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
    index = build_index(load_epg_channels(args.merged), load_sources(), rules)
    path = write_index(index, args.out)
    print(f"🌐 {path}: {len(index['channels'])} canales, {len(index['sources'])} fuentes "
          f"({os.path.getsize(path) / 1024 / 1024:.1f} MB)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
