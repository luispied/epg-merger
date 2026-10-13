"""Fuentes de guía privadas: epg_urls.json y epg_sources_catalog.json viven en R2 (prefijo fuentes/), no en el repo.

pull: los baja a la carpeta del repo para que merge_epgs.py los lea como siempre. Están en .gitignore, así no se
      vuelven a commitear. Si no se pueden bajar, falla: sin sus fuentes la corrida no fusiona nada.
push ARCHIVO...: sube archivos locales a R2 con su nombre (lo usa discover-sources.yml).
editar ARCHIVO: baja el objeto de R2 a un archivo temporal fuera del repo, lo abre en $EDITOR, lo valida y lo sube.
      Antes de subir, guarda la versión anterior en fuentes/backup/<fecha-hora>/ARCHIVO.
restaurar ARCHIVO FECHA: vuelve a subir una copia de fuentes/backup/FECHA/ARCHIVO (FECHA como aparece en el backup).

Uso: python tools/fuentes_r2.py pull | push ARCHIVO... | editar ARCHIVO | restaurar ARCHIVO FECHA
"""
import datetime
import json
import os
import shlex
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


def _nombre_valido(nombre):
    if nombre not in ARCHIVOS:
        raise SystemExit(f'{nombre}: no es un archivo de fuentes')
    return nombre


def validar(ruta):
    """Mismas reglas de forma que merge_epgs.load_sources: un objeto JSON con la lista «sources» o «urls»,
    y cada entrada es un texto (la URL) o un objeto con «url» o «id». Devuelve el error o None."""
    try:
        with open(ruta, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        return f'no es JSON válido ({e})'
    if not isinstance(config, dict):
        return 'la raíz tiene que ser un objeto'
    raw = config.get('sources', config.get('urls'))
    if not isinstance(raw, list):
        return 'falta la lista «sources» (o «urls»)'
    for i, entrada in enumerate(raw):
        if isinstance(entrada, str):
            continue
        if not isinstance(entrada, dict) or not (entrada.get('url') or entrada.get('id')):
            return f'la entrada {i} no tiene «url» ni «id»'
    return None


def pull(destino='.'):
    s3 = cliente()
    for nombre in ARCHIVOS:
        s3.download_file(bucket(), PREFIJO + nombre, os.path.join(destino, nombre))
        print(f'✓ {nombre} desde R2')


def push(rutas):
    s3 = cliente()
    for ruta in rutas:
        nombre = _nombre_valido(os.path.basename(ruta))
        s3.upload_file(ruta, bucket(), PREFIJO + nombre)
        print(f'✓ {nombre} a R2')


def editar(nombre, s3=None, editor=None):
    """Edita el objeto de R2 con $EDITOR. Si no cambió o no pasa la validación, no sube nada."""
    _nombre_valido(nombre)
    s3 = s3 or cliente()
    editor = editor or os.environ.get('EDITOR') or 'vi'
    carpeta = tempfile.mkdtemp(prefix='fuentes-r2-')  # fuera del repo
    ruta = os.path.join(carpeta, nombre)
    s3.download_file(bucket(), PREFIJO + nombre, ruta)
    with open(ruta, 'rb') as f:
        original = f.read()
    subprocess.run([*shlex.split(editor), ruta], check=True)
    with open(ruta, 'rb') as f:
        nuevo = f.read()
    if nuevo == original:
        shutil.rmtree(carpeta)
        print(f'{nombre}: sin cambios, no se subió nada')
        return False
    error = validar(ruta)
    if error:
        print(f'❌ {nombre} no se subió: {error}. Tu edición quedó en {ruta}')
        return False
    fecha = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d-%H%M%S')
    s3.copy_object(Bucket=bucket(), Key=f'{BACKUP}{fecha}/{nombre}',
                   CopySource={'Bucket': bucket(), 'Key': PREFIJO + nombre})
    print(f'✓ copia anterior en {BACKUP}{fecha}/{nombre}')
    s3.upload_file(ruta, bucket(), PREFIJO + nombre)
    shutil.rmtree(carpeta)
    print(f'✓ {nombre} editado en R2')
    return True


def restaurar(nombre, fecha, s3=None):
    """Guarda la versión actual como backup y después vuelve la de fecha."""
    _nombre_valido(nombre)
    s3 = s3 or cliente()
    ahora = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d-%H%M%S')
    s3.copy_object(Bucket=bucket(), Key=f'{BACKUP}{ahora}/{nombre}',
                   CopySource={'Bucket': bucket(), 'Key': PREFIJO + nombre})
    s3.copy_object(Bucket=bucket(), Key=PREFIJO + nombre,
                   CopySource={'Bucket': bucket(), 'Key': f'{BACKUP}{fecha}/{nombre}'})
    print(f'✓ {nombre} restaurado desde {BACKUP}{fecha}/ (la versión anterior quedó en {BACKUP}{ahora}/)')


if __name__ == '__main__':
    if sys.argv[1:2] == ['pull']:
        pull()
    elif sys.argv[1:2] == ['push'] and len(sys.argv) > 2:
        push(sys.argv[2:])
    elif sys.argv[1:2] == ['editar'] and len(sys.argv) == 3:
        editar(sys.argv[2])
    elif sys.argv[1:2] == ['restaurar'] and len(sys.argv) == 4:
        restaurar(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)
