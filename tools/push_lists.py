#!/usr/bin/env python3
"""Sube al Worker de Grilla la lista del proveedor de cada perfil que tenga configuración de
Grilla web (`"grilla": {"cfg": …, "key": …}` en XTREAM_PROFILES).

Hace falta porque el proveedor bloquea los pedidos que salen de Cloudflare: el Worker no puede
bajar la lista y la baja GitHub (workflow refresh-lists.yml, cada 3 horas). Se sube sin
credenciales ni URLs de stream: nombre, categoría, stream_id, extensión, logo e id de EPG. Con
eso el Worker arma la playlist, y cada canal pasa por su redirect al servidor sano.

Uso: `python tools/push_lists.py --worker https://grilla.….workers.dev`.
"""
import argparse
import os
import sys
import urllib.parse

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from profiles import load_profiles  # noqa: E402
from xtream_client import XtreamError, get_live_categories, get_live_streams  # noqa: E402

TIMEOUT = 120


def worker_channels(streams, categories):
    """Canales en el formato del Worker (worker/src/provider.ts → Channel), sin URLs."""
    return [{
        'name': s.get('name') or '',
        'category': categories.get(str(s.get('category_id')), 'General'),
        'id': str(s.get('stream_id') or ''),
        'ext': s.get('container_extension') or 'm3u8',
        'icon': s.get('stream_icon') or '',
        'epgId': s.get('epg_channel_id') or None,
    } for s in streams if str(s.get('stream_id') or '').isdigit()]


def push(profile, worker, session=requests):
    server, streams = get_live_streams(profile['servers'], profile['username'], profile['password'])
    categories = get_live_categories(server, profile['username'], profile['password'])
    channels = worker_channels(streams, categories)
    grilla = profile['grilla']
    r = session.put(f"{worker}/api/cfg/{urllib.parse.quote(grilla['cfg'])}/list", timeout=TIMEOUT,
                    headers={'Authorization': f"Bearer {grilla['key']}"}, json={'channels': channels})
    if not r.ok:
        raise RuntimeError(f"el Worker respondió HTTP {r.status_code}: {r.text[:200]}")
    return len(channels)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--worker', required=True)
    args = ap.parse_args(argv)
    worker = args.worker.rstrip('/')

    targets = [p for p in load_profiles() if p.get('type', 'xtream') == 'xtream' and p.get('grilla')]
    if not targets:
        print("ℹ️  Ningún perfil tiene configuración de Grilla web ('grilla' en XTREAM_PROFILES): nada para subir")
        return 0
    failed = 0
    for profile in targets:
        try:
            print(f"✅ {profile['name']}: {push(profile, worker)} canales subidos")
        except (XtreamError, RuntimeError, requests.RequestException) as e:
            failed += 1
            # Sin detalles del pedido: la URL del proveedor lleva las credenciales.
            print(f"❌ {profile['name']}: {type(e).__name__}: {str(e)[:200] if not isinstance(e, requests.RequestException) else ''}")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
