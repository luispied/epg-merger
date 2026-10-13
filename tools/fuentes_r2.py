"""Fuentes de guía privadas: epg_urls.json y epg_sources_catalog.json viven en R2 (prefijo fuentes/), no en el repo.

pull:     los baja a la carpeta del repo para que merge_epgs.py los lea como siempre. Están en .gitignore, así no se
          vuelven a commitear. Si no se pueden bajar, falla: sin sus fuentes la corrida no fusiona nada.
push ARCHIVO...: sube archivos locales a R2 con su nombre (lo usa discover-sources.yml, desde una carpeta temporal).
respaldo: copia lo que hay hoy en R2 a fuentes/backup/<fecha>/ antes de tocarlo.
editar NOMBRE: baja el archivo a una carpeta temporal fuera del repo, lo abre en $EDITOR, valida el JSON, guarda
          el respaldo y lo sube. Es la única forma de cambiar las fuentes: el repo no guarda nada de ellas.

Uso: python tools/fuentes_r2.py pull | push ARCHIVO... | respaldo | editar NOMBRE
"""
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile

ARCHIVOS = ('epg_urls.json', 'epg_sources_catalog.json')
PREFIJO = 'fuentes/'
BACKUP = PREFIJO + 'backup/'


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


def existe(s3, clave):
    return any(o['Key'] == clave for pagina in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket(), Prefix=clave)
               for o in pagina.get('Contents', []))


def respaldo(s3, nombre, fecha):
    """Copia lo que hay en R2 para `nombre` a fuentes/backup/<fecha>/. Si no hay nada, no hace nada."""
    if not existe(s3, PREFIJO + nombre):
        return None
    cuerpo = s3.get_object(Bucket=bucket(), Key=PREFIJO + nombre)['Body'].read()
    clave = f'{BACKUP}{fecha}/{nombre}'
    s3.put_object(Bucket=bucket(), Key=clave, Body=cuerpo, ContentType='application/json')
    return clave


def validar(texto):
    """El JSON tiene que ser un objeto con la lista «sources» (formato nuevo) o «urls» (el viejo)."""
    datos = json.loads(texto)  # lanza ValueError si no es JSON
    if not isinstance(datos, dict) or not isinstance(datos.get('sources', datos.get('urls')), list):
        raise ValueError('falta la lista «sources» (o «urls»)')
    return datos


def editar(nombre, s3=None, editor=None):
    if nombre not in ARCHIVOS:
        raise SystemExit(f'{nombre}: no es un archivo de fuentes')
    s3 = s3 or cliente()
    fecha = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H%M%SZ')
    carpeta = tempfile.mkdtemp(prefix='fuentes-')  # fuera del repo: nada de esto se commitea
    try:
        ruta = os.path.join(carpeta, nombre)
        if not existe(s3, PREFIJO + nombre):
            raise SystemExit(f'{nombre}: no está en R2 (corré primero push)')
        original = s3.get_object(Bucket=bucket(), Key=PREFIJO + nombre)['Body'].read()
        with open(ruta, 'wb') as f:
            f.write(original)
        subprocess.run([editor or os.environ.get('EDITOR', 'vi'), ruta], check=True)
        with open(ruta, 'r', encoding='utf-8') as f:
            nuevo = f.read()
        if nuevo.encode('utf-8') == original:
            print(f'{nombre}: sin cambios')
            return None
        try:
            validar(nuevo)
        except ValueError as e:
            raise SystemExit(f'{nombre}: no se sube, JSON inválido: {e}')
        clave_backup = respaldo(s3, nombre, fecha)
        s3.put_object(Bucket=bucket(), Key=PREFIJO + nombre, Body=nuevo.encode('utf-8'),
                      ContentType='application/json')
        print(f'✓ {nombre} subido a R2 (respaldo: {clave_backup})')
        return clave_backup
    finally:
        shutil.rmtree(carpeta, ignore_errors=True)


if __name__ == '__main__':
    if sys.argv[1:2] == ['pull']:
        pull()
    elif sys.argv[1:2] == ['push'] and len(sys.argv) > 2:
        push(sys.argv[2:])
    elif sys.argv[1:2] == ['respaldo']:
        s3, fecha = cliente(), datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H%M%SZ')
        for nombre in ARCHIVOS:
            print(respaldo(s3, nombre, fecha) or f'{nombre}: no está en R2')
    elif sys.argv[1:2] == ['editar'] and len(sys.argv) == 3:
        editar(sys.argv[2])
    else:
        raise SystemExit(__doc__)
