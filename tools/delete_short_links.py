#!/usr/bin/env python3
"""Borra TODOS los links cortos de reproducción de Grilla web en R2 (short/ y devices/).

Las playlists y guías que ya estaban cargadas en algún reproductor dejan de funcionar; las
configuraciones no se tocan y los links se generan de nuevo desde "Tus links" (ahora uno por
dispositivo, con nombre). No toca los links largos (/p/<cfg>/<token>/…): esos no se guardan en
ningún lado y solo se invalidan cambiando TOKEN_KEY del Worker.

Uso: `python tools/delete_short_links.py` (con las variables de R2), o el workflow
"Delete Grilla short links".
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from push_lists import R2  # noqa: E402

PREFIXES = ('short/', 'devices/')


def delete_all(r2):
    """Devuelve la cantidad de claves borradas por prefijo."""
    counts = {}
    for prefix in PREFIXES:
        n = 0
        for key in list(r2.keys(prefix)):
            r2.delete(key)
            n += 1
        counts[prefix] = n
    return counts


def main():
    needed = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if not all(os.environ.get(k) for k in needed):
        print('❌ Faltan las credenciales de R2')
        return 1
    import boto3
    client = boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')
    counts = delete_all(R2(client, os.environ.get('R2_BUCKET') or 'grilla'))
    for prefix, n in counts.items():
        print(f'🗑️  {prefix}: {n} borrados')
    return 0


if __name__ == '__main__':
    sys.exit(main())
