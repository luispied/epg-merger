"""Sube a R2 una carpeta (o un archivo) escribiendo solo lo que cambió.

`aws s3 sync` compara tamaño y fecha: como la corrida arma todo de nuevo, subía todos los archivos
cada vez, aunque fueran iguales, y cada subida es una escritura de clase A. Acá se compara el MD5
de lo que se va a subir con el ETag que R2 ya tiene (en una subida de una sola parte el ETag es el
MD5) y se sube solo lo distinto. Con --gzip se comprime antes (siempre igual: sin fecha adentro) y
se guarda con Content-Encoding: gzip; el Worker lo lee o lo entrega así.

Uso: python tools/r2_sync.py <carpeta o archivo> <prefijo o clave> [--type T] [--gzip | --encoding gzip] [--delete]
     (--delete: borra lo que hay bajo el prefijo y ya no está en la carpeta)
"""
import argparse
import gzip
import hashlib
import os
import sys
from concurrent.futures import ThreadPoolExecutor


def local_files(src, prefix):
    """{clave: ruta} de lo que hay que subir."""
    if os.path.isfile(src):
        return {prefix: src}
    out = {}
    base = prefix.rstrip('/') + '/'
    for d, _, names in os.walk(src):
        for name in names:
            path = os.path.join(d, name)
            out[base + os.path.relpath(path, src).replace(os.sep, '/')] = path
    return out


def remote_etags(client, bucket, prefix):
    etags = {}
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            etags[obj['Key']] = obj['ETag'].strip('"')
    return etags


def sync(client, bucket, src, prefix, content_type='application/octet-stream', gz=False, delete=False, encoding=None):
    """Devuelve (subidos, iguales, borrados). `encoding`: Content-Encoding de archivos que ya vienen comprimidos."""
    files = local_files(src, prefix)
    etags = remote_etags(client, bucket, prefix if os.path.isfile(src) else prefix.rstrip('/') + '/')
    extra = {'ContentType': content_type}
    if gz or encoding:
        extra['ContentEncoding'] = 'gzip' if gz else encoding

    def put(item):
        key, path = item
        with open(path, 'rb') as f:
            body = f.read()
        if gz:
            body = gzip.compress(body, compresslevel=9, mtime=0)
        if etags.get(key) == hashlib.md5(body).hexdigest():
            return False
        client.put_object(Bucket=bucket, Key=key, Body=body, **extra)
        return True

    with ThreadPoolExecutor(16) as pool:
        done = list(pool.map(put, sorted(files.items())))
    uploaded, same = sum(done), len(done) - sum(done)
    gone = sorted(k for k in etags if k not in files) if delete and not os.path.isfile(src) else []
    for i in range(0, len(gone), 1000):
        client.delete_objects(Bucket=bucket, Delete={'Objects': [{'Key': k} for k in gone[i:i + 1000]], 'Quiet': True})
    return uploaded, same, len(gone)


def client_from_env():
    import boto3
    return boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('src')
    ap.add_argument('prefix')
    ap.add_argument('--type', default='application/octet-stream')
    ap.add_argument('--gzip', action='store_true')
    ap.add_argument('--encoding', help='Content-Encoding de archivos que ya vienen comprimidos (gzip)')
    ap.add_argument('--delete', action='store_true')
    args = ap.parse_args(argv)
    if not os.path.exists(args.src):
        print(f'ℹ️  Sin {args.src}: nada para subir.')
        return 0
    bucket = os.environ.get('R2_BUCKET') or 'grilla'
    up, same, gone = sync(client_from_env(), bucket, args.src, args.prefix, args.type, args.gzip, args.delete, args.encoding)
    print(f'☁️  {args.prefix}: {up} subidos, {same} iguales' + (f', {gone} borrados' if gone else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
