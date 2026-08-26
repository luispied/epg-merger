#!/usr/bin/env python3
"""Publica la playlist de cada perfil en su gist secreto.

Las playlists llevan usuario y contraseña dentro de cada URL de stream, así que no pueden ir
a un release público. Un gist secreto tiene una URL inadivinable que no pide autenticación,
que es lo que necesitan los reproductores tipo TiviMate:

    https://gist.githubusercontent.com/<usuario>/<gist_id>/raw/playlist.m3u8

Ojo con el modelo de amenaza: "secreto" acá significa inadivinable, no privado. Quien tenga
la URL ve el contenido. Es el mismo modelo que las credenciales viviendo dentro de la URL del
stream, y una mejora grande frente a un asset de release público e indexable — pero no es
cifrado.

Requiere un secret GIST_TOKEN: un PAT con scope `gist`. El GITHUB_TOKEN del workflow no sirve,
no tiene permiso sobre gists.
"""
import os
import sys

import requests

from profiles import OUTPUT_DIR, load_profiles

GIST_API = 'https://api.github.com/gists'
PLAYLIST_FILENAME = 'playlist.m3u8'
# La API de gists rechaza archivos muy grandes; se avisa antes de intentarlo.
MAX_GIST_BYTES = 5 * 1024 * 1024


def publish(profile, token, timeout=30):
    name = profile['name']
    gist_id = profile.get('gist_id')
    if not gist_id:
        print(f"ℹ️  Perfil {name!r} sin 'gist_id' configurado; su playlist no se publica")
        return False

    path = os.path.join(OUTPUT_DIR, name, PLAYLIST_FILENAME)
    if not os.path.exists(path):
        print(f"⚠️  Perfil {name!r}: no existe {path}, se omite")
        return False

    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    size = len(content.encode('utf-8'))
    if size > MAX_GIST_BYTES:
        print(f"❌ Perfil {name!r}: la playlist pesa {size / 1024 / 1024:.1f} MB, "
              f"por encima del límite de {MAX_GIST_BYTES / 1024 / 1024:.0f} MB de un gist")
        return False

    try:
        response = requests.patch(
            f"{GIST_API}/{gist_id}",
            headers={
                'Authorization': f'Bearer {token}',
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            json={'files': {PLAYLIST_FILENAME: {'content': content}}},
            timeout=timeout,
        )
        response.raise_for_status()
    except Exception as e:
        # El mensaje de error de la API no incluye el contenido, pero sí puede incluir el
        # gist_id; no se imprime nada del perfil más allá de su nombre.
        print(f"❌ Perfil {name!r}: falló la publicación en el gist ({type(e).__name__})")
        return False

    print(f"✅ Perfil {name!r}: playlist publicada ({size / 1024:.0f} KB)")
    return True


def main():
    token = os.environ.get('GIST_TOKEN')
    if not token:
        print("ℹ️  GIST_TOKEN no configurado; las playlists quedan solo en out/ "
              "(hace falta un PAT con scope 'gist' para publicarlas)")
        return 0

    profiles = load_profiles()
    if not profiles:
        print("ℹ️  Sin perfiles configurados; nada que publicar")
        return 0

    publicados = sum(publish(p, token) for p in profiles)
    print(f"\n📤 {publicados}/{len(profiles)} playlists publicadas")
    return 0


if __name__ == '__main__':
    sys.exit(main())
