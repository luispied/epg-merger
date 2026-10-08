#!/usr/bin/env python3
"""Guía de cada configuración de Grilla web (Etapa 1): `epg/<cfgId>.xml.gz` en R2.

El Worker no puede armarla al pedirla (límites del plan gratis de Cloudflare), así que la
arma la corrida diaria, igual que la guía de cada perfil: una sola pasada por la guía
escribiendo todas a la vez. Cada una lleva los canales de guía elegidos en su configuración
(`channels[nombre].epg`) y su programación.

Uso: `python tools/config_epgs.py --configs <dir con cfg/*.json> --out out/cfg_epg`.
"""
import argparse
import contextlib
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generate_playlist as gp  # noqa: E402
from source_alias import channel_alias, is_channel_alias  # noqa: E402


def chosen_ids(config):
    return {e['epg'] for e in (config.get('channels') or {}).values()
            if isinstance(e, dict) and isinstance(e.get('epg'), str) and e['epg']}


def load_configs(configs_dir):
    """{cfgId: config} de los cfg/<cfgId>.json bajados de R2 (los ilegibles se saltean)."""
    out = {}
    for path in sorted(glob.glob(os.path.join(configs_dir, '*.json'))):
        try:
            with open(path, encoding='utf-8') as f:
                out[os.path.splitext(os.path.basename(path))[0]] = json.load(f)
        except (OSError, json.JSONDecodeError):
            print(f"⚠️  {os.path.basename(path)} ilegible, se saltea")
    return out


def build(configs, merged_path, out_dir):
    if not configs:
        print("ℹ️  Sin configuraciones de Grilla web: no hay guías para armar")
        return {}
    os.makedirs(out_dir, exist_ok=True)
    channels_root = gp.load_epg_channels(merged_path)
    # Las configuraciones guardan el alias del id de canal (la guía de la web va enmascarada) o, las
    # viejas, el id real: los dos llevan al id real de la guía (y de ahí a sus programas).
    real = {}
    for c in channels_root.findall('channel'):
        if c.get('id'):
            real.setdefault(c.get('id'), c.get('id'))
            real.setdefault(channel_alias(c.get('id')), c.get('id'))
    guides = {}
    for cfg_id, config in configs.items():
        # Cada canal sale con el id que guardó la configuración (el tvg-id de su playlist): el alias, o el
        # real si todavía no se abrió en la web con la guía enmascarada. El alias gana si están los dos.
        out_ids = {}
        for i in sorted(chosen_ids(config), key=is_channel_alias):
            if i in real:
                out_ids[real[i]] = i
        guides[cfg_id] = gp.ProfileEpg(os.path.join(out_dir, f'{cfg_id}.xml.gz'), channels_root, set(out_ids), {}, {},
                                       out_ids=out_ids)
    with contextlib.ExitStack() as stack:
        for guide in guides.values():
            guide.open(stack)
        for programme in gp.iter_programmes(merged_path):
            for guide in guides.values():
                guide.write_programme(programme)
    stats = {cfg_id: len(g.matched_ids) for cfg_id, g in guides.items()}
    print(f"🗓️  Guías de Grilla web: {len(stats)} configuración(es), "
          f"{sum(stats.values())} canales de guía en total")
    return stats


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--configs', required=True)
    ap.add_argument('--merged', default=gp.MERGED_EPG_PATH)
    ap.add_argument('--out', default=os.path.join('out', 'cfg_epg'))
    args = ap.parse_args(argv)
    build(load_configs(args.configs), args.merged, args.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
