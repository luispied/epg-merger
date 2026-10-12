"""Fuentes de guía privadas: epg_urls.json y epg_sources_catalog.json viven en R2 (prefijo fuentes/), no en el repo.

pull: los baja a la carpeta del repo para que merge_epgs.py los lea como siempre. Están en .gitignore, así no se
      vuelven a commitear. Si no se pueden bajar, falla: sin sus fuentes la corrida no fusiona nada.
push ARCHIVO...: sube archivos locales a R2 con su nombre (lo usa discover-sources.yml y el workflow manual).

Uso: python tools/fuentes_r2.py pull | push ARCHIVO...
"""
import os
import sys

ARCHIVOS = ('epg_urls.json', 'epg_sources_catalog.json')
PREFIJO = 'fuentes/'


def cliente():
    import boto3
    return boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
    )


def bucket():
    return os.environ.get('R2_BUCKET') or 'grilla'


def pull(destino='.'):
    s3 = cliente()
    for nombre in ARCHIVOS:
        s3.download_file(bucket(), PREFIJO + nombre, os.path.join(destino, nombre))
        print(f'✓ {nombre} desde R2')


def push(rutas):
    s3 = cliente()
    for ruta in rutas:
        nombre = os.path.basename(ruta)
        if nombre not in ARCHIVOS:
            raise SystemExit(f'{nombre}: no es un archivo de fuentes')
        s3.upload_file(ruta, bucket(), PREFIJO + nombre)
        print(f'✓ {nombre} a R2')


if __name__ == '__main__':
    if sys.argv[1:2] == ['pull']:
        pull()
    elif sys.argv[1:2] == ['push'] and len(sys.argv) > 2:
        push(sys.argv[2:])
    else:
        raise SystemExit(__doc__)
