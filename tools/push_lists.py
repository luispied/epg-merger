#!/usr/bin/env python3
"""Lista del proveedor para Grilla web, bajada desde GitHub (workflow refresh-lists.yml).

El proveedor de Luis bloquea los pedidos que salen de Cloudflare: el Worker no puede bajar la
lista, GitHub sí. El Worker y GitHub se encuentran en R2 por una huella de usuario y
contraseña (worker/src/link.ts), sin guardarlos:

- `known/<huella>`: GitHub avisa qué cuentas tiene (las de XTREAM_PROFILES). Cuando alguien
  entra a la web con una de esas cuentas y el proveedor bloquea al Worker, la web no le pide
  que baje y suba la lista: la configuración queda anotada para GitHub.
- `links/<huella>.json`: `{"cfgIds": [...], "pending": true}`, lo anota el Worker.

En cada corrida (cada 10 minutos), para cada cuenta con configuraciones anotadas, se baja la
lista y se escribe `list/<cfgId>.json` si hay una configuración nueva (`pending`) o si la
lista tiene más de 3 horas. Sin credenciales ni URLs: nombre, categoría, stream_id,
extensión, logo e id de EPG.
"""
import datetime
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from profiles import load_profiles  # noqa: E402
from xtream_client import XtreamError, get_live_categories, get_live_streams  # noqa: E402

REFRESH_EVERY = datetime.timedelta(hours=3) - datetime.timedelta(minutes=5)


def link_hash(username, password):
    """La misma huella que worker/src/link.ts."""
    return hashlib.sha256(f'grilla-link\n{username}\n{password}'.encode('utf-8')).hexdigest()


def worker_channels(streams, categories):
    """Canales en el formato del Worker (worker/src/provider.ts → Channel), sin URLs."""
    return [{
        'name': s.get('name') or '',
        'category': categories.get(str(s.get('category_id')), 'General'),
        'id': str(s.get('stream_id') or ''),
        'ext': s.get('container_extension') or 'm3u8',
        'icon': s.get('stream_icon') or '',
        'epgId': s.get('epg_channel_id') or None,
    } for s in streams if str(s.get('stream_id') or '').strip()]


class R2:
    """Lo mínimo de R2 (API S3) que hace falta. Los tests lo reemplazan por uno en memoria."""

    def __init__(self, client, bucket):
        self.client, self.bucket = client, bucket

    def get(self, key):
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=key)
        except self.client.exceptions.NoSuchKey:
            return None
        return obj['Body'].read(), obj['LastModified']

    def put(self, key, body):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType='application/json')

    def keys(self, prefix):
        for page in self.client.get_paginator('list_objects_v2').paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get('Contents', []):
                yield obj['Key']

    def delete(self, key):
        self.client.delete_object(Bucket=self.bucket, Key=key)


def due(r2, cfg_ids, pending, now):
    if pending:
        return True
    for cfg_id in cfg_ids:
        current = r2.get(f'list/{cfg_id}.json')
        if current is None or now - current[1] >= REFRESH_EVERY:
            return True
    return False


def sync(r2, profiles, load=None, now=None):
    """Anota las cuentas conocidas y sube las listas que tocan. Devuelve {perfil: canales}."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    load = load or load_channels
    done = {}
    for profile in profiles:
        h = link_hash(profile['username'], profile['password'])
        r2.put(f'known/{h}', b'')
        link = r2.get(f'links/{h}.json')
        if link is None:
            continue
        data = json.loads(link[0] or b'{}')
        cfg_ids = [c for c in data.get('cfgIds', []) if r2.get(f'cfg/{c}.json') is not None]
        if not cfg_ids or not due(r2, cfg_ids, data.get('pending'), now):
            continue
        body = json.dumps({'channels': load(profile)}, ensure_ascii=False).encode('utf-8')
        for cfg_id in cfg_ids:
            r2.put(f'list/{cfg_id}.json', body)
        r2.put(f'links/{h}.json', json.dumps({'cfgIds': cfg_ids, 'pending': False}).encode('utf-8'))
        done[profile['name']] = len(cfg_ids)
    return done


def load_channels(profile):
    server, streams = get_live_streams(profile['servers'], profile['username'], profile['password'])
    return worker_channels(streams, get_live_categories(server, profile['username'], profile['password']))


def main():
    needed = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if not all(os.environ.get(k) for k in needed):
        print('ℹ️  Sin credenciales de R2: nada para hacer')
        return 0
    import boto3
    client = boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')
    profiles = [p for p in load_profiles() if p.get('type', 'xtream') == 'xtream']
    try:
        done = sync(R2(client, os.environ.get('R2_BUCKET') or 'grilla'), profiles)
    except XtreamError as e:
        # Sin detalles: la URL del proveedor lleva las credenciales.
        print(f'❌ El proveedor no respondió ({type(e).__name__})')
        return 1
    for name, n in done.items():
        print(f"✅ {name}: lista subida a {n} configuración(es)")
    if not done:
        print(f'ℹ️  {len(profiles)} cuenta(s) anotadas; ninguna lista para actualizar ahora')
    return 0


if __name__ == '__main__':
    sys.exit(main())
