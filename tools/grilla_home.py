#!/usr/bin/env python3
"""Sube la lista de tu proveedor a Grilla web desde un equipo de tu casa (Raspberry Pi, NAS,
una PC o un Android viejo con Termux), para no depender de GitHub.

Para qué: algunos proveedores (como el de Luis) no le contestan a Cloudflare, así que el Worker
no puede bajar la lista. Hoy la baja GitHub cada 3 horas; con esto la baja tu propia conexión
(la misma IP que usa tu reproductor) y la sube al Worker con tu clave de edición.

Datos (variables de entorno, o un archivo con `KEY=valor` por línea pasado con `--env`; ese
archivo tiene tus credenciales: dejalo legible solo para vos, `chmod 600`):
  GRILLA_CFG       id de tu configuración      (está en tu respaldo: Configuración → Exportar)
  GRILLA_KEY       clave de edición             (ídem; no la compartas)
  XTREAM_SERVERS   servidores separados por coma
  XTREAM_USERNAME  usuario del proveedor
  XTREAM_PASSWORD  contraseña del proveedor
  GRILLA_WORKER    opcional, https://grilla.grilla.workers.dev por defecto

Las credenciales del proveedor no salen de tu equipo: al Worker solo va la lista de canales
(nombres, categorías e ids, sin URLs).

Uso: `python tools/grilla_home.py --env ~/.grilla.env`, cada 3 horas con cron:
  `0 */3 * * * cd ~/epg-merger && python3 tools/grilla_home.py --env ~/.grilla.env`
"""
import argparse
import json
import os
import sys

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'tools'))

from push_lists import worker_channels  # noqa: E402
from xtream_client import XtreamError, get_live_categories, get_live_streams  # noqa: E402

DEFAULT_WORKER = 'https://grilla.grilla.workers.dev'


def read_env_file(path):
    out = {}
    with open(os.path.expanduser(path), encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def settings(env):
    need = ('GRILLA_CFG', 'GRILLA_KEY', 'XTREAM_SERVERS', 'XTREAM_USERNAME', 'XTREAM_PASSWORD')
    missing = [k for k in need if not env.get(k)]
    if missing:
        raise ValueError(f"faltan: {', '.join(missing)}")
    return {
        'worker': (env.get('GRILLA_WORKER') or DEFAULT_WORKER).rstrip('/'),
        'cfg': env['GRILLA_CFG'], 'key': env['GRILLA_KEY'],
        'servers': [s.strip() for s in env['XTREAM_SERVERS'].split(',') if s.strip()],
        'username': env['XTREAM_USERNAME'], 'password': env['XTREAM_PASSWORD'],
    }


def upload(s, channels, session=requests):
    res = session.put(f"{s['worker']}/api/cfg/{s['cfg']}/list", timeout=120,
                      headers={'Authorization': f"Bearer {s['key']}", 'Content-Type': 'application/json'},
                      data=json.dumps({'channels': channels}, ensure_ascii=False).encode('utf-8'))
    if res.status_code != 200:
        raise RuntimeError(f"el Worker respondió {res.status_code}: {res.text[:200]}")
    return res.json().get('channels', len(channels))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--env', help='archivo KEY=valor con los datos (chmod 600)')
    args = ap.parse_args(argv)
    env = dict(os.environ)
    if args.env:
        env.update(read_env_file(args.env))
    try:
        s = settings(env)
        server, streams = get_live_streams(s['servers'], s['username'], s['password'])
        channels = worker_channels(streams, get_live_categories(server, s['username'], s['password']))
        n = upload(s, channels)
    except XtreamError as e:
        # Sin detalles: la URL del proveedor lleva las credenciales.
        print(f'❌ El proveedor no respondió ({type(e).__name__})')
        return 1
    except (ValueError, RuntimeError, requests.RequestException) as e:
        print(f'❌ {e}')
        return 1
    print(f'✅ Lista subida: {n} canales')
    return 0


if __name__ == '__main__':
    sys.exit(main())
