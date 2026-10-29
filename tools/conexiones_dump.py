"""Vuelca lo que se guardó de conexiones en uso (conn/) y de canales abiertos (play/) para leer la barra de 24 horas y
«Probable» en tu computadora. Solo lee R2; no escribe nada.

Salida (texto): por cuenta, las muestras de las últimas 24 horas con su número, y las subidas. Por link, la hora y el
canal de cada apertura (sin código de link: el canal es el id de la lista). Para cada apertura, si el número de
conexiones subió dentro de la hora siguiente, va «subió». Así se ve si «Probable» dice la verdad.
Las huellas de cuenta son las de accountKey (no hay usuarios ni contraseñas en la salida).
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import boto3

WINDOW = timedelta(hours=24)
PROBABLE = timedelta(minutes=60)
PROBABLE_MIN = int(PROBABLE.total_seconds() // 60)


def client():
    return boto3.client('s3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
                        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'], region_name='auto')


def listed(s3, bucket, prefix):
    token = None
    while True:
        kw = {'Bucket': bucket, 'Prefix': prefix, **({'ContinuationToken': token} if token else {})}
        page = s3.list_objects_v2(**kw)
        for o in page.get('Contents', []):
            yield o['Key']
        if not page.get('IsTruncated'):
            return
        token = page['NextContinuationToken']


def load(s3, bucket, key):
    return json.loads(s3.get_object(Bucket=bucket, Key=key)['Body'].read())


def when(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def main():
    s3 = client()
    bucket = os.environ['R2_BUCKET']
    now = datetime.now(timezone.utc)
    since = now - WINDOW
    print(f"Ventana: {since:%Y-%m-%d %H:%M} a {now:%Y-%m-%d %H:%M} UTC\n")

    rises = []
    for key in listed(s3, bucket, 'conn/'):
        acc = key.rsplit('/', 1)[-1].removesuffix('.json')
        points = [p for p in load(s3, bucket, key) if when(p['t']) >= since]
        print(f"Cuenta {acc[:8]}: {len(points)} muestras")
        prev = None
        for p in points:
            up = prev is not None and p['n'] > prev['n']
            print(f"  {when(p['t']):%H:%M} en uso {p['n']}{' (subió)' if up else ''}")
            if up:
                rises.append((acc, when(p['t'])))
            prev = p
        print()

    print("Aperturas de canal (play/), últimas 24 horas:")
    for key in listed(s3, bucket, 'play/'):
        p = load(s3, bucket, key)
        t = when(p['t'])
        if t < since:
            continue
        after = [r for a, r in rises if r >= t and r - t <= PROBABLE]
        print(f"  {t:%H:%M} canal {p['ch']}: {'subió' if after else 'sin subida'} en {PROBABLE_MIN} min")
    print()
    print(f"Subidas totales: {len(rises)}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
