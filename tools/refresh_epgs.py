#!/usr/bin/env python3
"""Guía de Grilla web para las configuraciones nuevas o cambiadas, sin esperar a la corrida
diaria (workflow refresh-lists.yml, cada pocas horas y cuando el Worker lo pide).

La corrida diaria arma `epg/<cfgId>.xml.gz` de todas las configuraciones. Una configuración
creada o editada después quedaba sin guía, o con la vieja, hasta el día siguiente. Esto arma
solo las que lo necesitan (su guía no existe o es más vieja que la configuración) con la guía
ya fusionada de la última corrida (`merged.xml.gz` del release): no vuelve a bajar las
fuentes, así no se les pide más de una vez por día.

Esas guías apuntan los logos e imágenes al Worker (`/logo/<clave>`, `/img/<clave>`), que los
encuentra en los mapas `logo/map/` e `img/map/` de R2. Antes de subir una guía se suben también
los mapas de ese mismo `merged.xml.gz`: si no, una guía armada entre corridas diarias podía
apuntar a claves que el Worker todavía no conoce (pasó al estrenar los logos por el Worker y
TiviMate se quedó sin logos). Si faltan los mapas en R2, se suben aunque no haya guías para armar.
"""
import json
import os
import sys
import tempfile

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config_epgs  # noqa: E402
import pack_schedule  # noqa: E402
import r2_sync  # noqa: E402
import shared_guide  # noqa: E402

MERGED_URL = 'https://github.com/{repo}/releases/download/latest/merged.xml.gz'
API_RELEASE = 'https://api.github.com/repos/{repo}/releases/tags/latest'


def listing(client, bucket, prefix):
    """{nombre sin prefijo ni extensión: LastModified} de los objetos con ese prefijo."""
    out = {}
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            name = obj['Key'][len(prefix):].split('.')[0]
            if name:
                out[name] = obj['LastModified']
    return out


def download_merged(repo, dest, token=None):
    """Baja `merged.xml.gz` del release `latest`. Con `token` (el GITHUB_TOKEN de la corrida) lo pide por la
    API autenticada, que funciona también si el repo es privado; sin token usa la URL pública."""
    if token:
        headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'}
        rel = requests.get(API_RELEASE.format(repo=repo), headers=headers, timeout=60)
        rel.raise_for_status()
        asset = next((a for a in rel.json().get('assets', []) if a.get('name') == 'merged.xml.gz'), None)
        if asset is None:
            raise RuntimeError('el release latest no tiene merged.xml.gz')
        # La API redirige a un almacenamiento externo: requests no reenvía el token a otro host.
        url, headers = asset['url'], {**headers, 'Accept': 'application/octet-stream'}
    else:
        url, headers = MERGED_URL.format(repo=repo), {}
    with requests.get(url, headers=headers, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(dest, 'wb') as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)


def upload_media_maps(client, bucket, merged, tmp):
    """Sube los mapas {clave: url} de `merged` (los mismos que arma shared_guide.py en la corrida diaria),
    en gzip y solo los que cambiaron (tools/r2_sync.py): entre corridas diarias suelen ser los mismos."""
    maps = shared_guide.media_maps(shared_guide.load_epg_channels(merged), shared_guide.iter_programmes(merged))
    out = os.path.join(tmp, 'shared')
    count = 0
    for d in shared_guide.write_media_maps(maps, out):
        prefix = os.path.relpath(d, out).replace(os.sep, '/')
        count += r2_sync.sync(client, bucket, d, prefix, 'application/json', gz=True)[0]
    print(f"🖼️  Mapas de imágenes: {len(maps['logo'])} logos, {len(maps['img'])} de programas ({count} archivos subidos)")
    return count


def upload_hour_packs(client, bucket, merged, configs, tmp):
    """El índice por hora de cada configuración (ui/schedule/cfg/<cfgId>, tools/pack_schedule.py). Mientras no
    está al día, el Worker entrega el de toda la guía: esto solo lo achica antes de la corrida diaria."""
    if not configs:
        return 0
    src = pack_schedule.hours_from_merged(merged, os.path.join(tmp, 'schedule'))
    dst = os.path.join(tmp, 'schedule_cfg')
    genres = None
    try:  # los géneros que la IA ya clasificó, para el filtro por género de la Guía; sin ellos, el índice sale sin "g"
        path = os.path.join(tmp, 'genres.json')
        client.download_file(bucket, 'ai/genres.json', path)
        with open(path, encoding='utf-8') as f:
            genres = json.load(f)
    except Exception:  # noqa: BLE001
        genres = None
    pack_schedule.pack_configs(configs, src, dst, genres)
    for cfg_id in configs:
        client.upload_file(os.path.join(dst, cfg_id), bucket, f'ui/schedule/cfg/{cfg_id}',
                           ExtraArgs={'ContentType': 'application/octet-stream'})
    return len(configs)


def stale(configs, epgs):
    """Configuraciones sin guía o con una guía más vieja que la configuración."""
    return sorted(c for c, modified in configs.items() if c not in epgs or epgs[c] < modified)


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
    bucket = os.environ.get('R2_BUCKET') or 'grilla'
    todo = stale(listing(client, bucket, 'cfg/'), listing(client, bucket, 'epg/'))
    maps_missing = not listing(client, bucket, 'logo/map/')
    if not todo and not maps_missing:
        print('ℹ️  Todas las configuraciones tienen su guía al día')
        return 0
    repo = os.environ.get('GITHUB_REPOSITORY', 'luispied/epg-merger')
    with tempfile.TemporaryDirectory() as tmp:
        merged = os.path.join(tmp, 'merged.xml.gz')
        download_merged(repo, merged, os.environ.get('GITHUB_TOKEN'))
        # Primero los mapas: una guía nueva no puede apuntar a un logo que el Worker no encuentra.
        upload_media_maps(client, bucket, merged, tmp)
        if not todo:
            return 0
        cfg_dir = os.path.join(tmp, 'cfg')
        os.makedirs(cfg_dir)
        for cfg_id in todo:
            client.download_file(bucket, f'cfg/{cfg_id}.json', os.path.join(cfg_dir, f'{cfg_id}.json'))
        out_dir = os.path.join(tmp, 'epg')
        configs = config_epgs.load_configs(cfg_dir)
        config_epgs.build(configs, merged, out_dir)
        for cfg_id in todo:
            path = os.path.join(out_dir, f'{cfg_id}.xml.gz')
            if os.path.exists(path):
                client.upload_file(path, bucket, f'epg/{cfg_id}.xml.gz', ExtraArgs={'ContentType': 'application/gzip'})
        upload_hour_packs(client, bucket, merged, {c: configs[c] for c in todo if c in configs}, tmp)
    print(f'✅ Guía armada para {len(todo)} configuración(es)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
