#!/usr/bin/env python3
"""Qué configuraciones de Grilla web no se usan, para no armarles la guía nueva en cada corrida.

Una configuración está en uso si pasó algo de esto en los últimos IDLE_DAYS días:
- la editaron: `cfg/<cfgId>.json` cambió en R2 (el Worker lo escribe en cada edición), o
- alguno de sus links de reproducción se usó: `lastUsed` de `short/<código>.json`, que el Worker anota
  como mucho una vez por hora.

Lo que queda sin uso no se borra ni se cambia: su `epg/<cfgId>.xml.gz` y sus links siguen como están.
Si alguien vuelve a usar el link, el Worker anota el uso y la corrida siguiente la vuelve a armar; si
edita la configuración, tools/refresh_epgs.py la arma a la hora. Su índice por hora sigue armándose en
cada corrida, porque es el que lee la Guía de la edición (sin él, la Guía mostraría la guía de todos).

Uso: `python tools/config_activity.py --out out/idle.json` (con las variables de R2). Escribe
`{"days": N, "configs": [cfgId, ...], "total": N}`; tools/config_epgs.py lo lee con --idle.
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from r2 import R2  # noqa: E402

IDLE_DAYS = 30


def parse_time(value):
    """Fecha ISO (la que escribe el Worker) como datetime con zona; None si no se entiende."""
    if not isinstance(value, str) or not value:
        return None
    try:
        t = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def last_used_by_config(records):
    """{cfgId: último uso} de los links cortos ya leídos (dicts de short/). Los que no se entienden no cuentan."""
    out = {}
    for rec in records:
        if not isinstance(rec, dict):
            continue
        cfg_id, used = rec.get('cfgId'), parse_time(rec.get('lastUsed'))
        if isinstance(cfg_id, str) and cfg_id and used and (cfg_id not in out or used > out[cfg_id]):
            out[cfg_id] = used
    return out


def idle_configs(modified, last_used, now, days=IDLE_DAYS):
    """Los cfgId de `modified` ({cfgId: última edición}) sin edición ni link usado desde hace más de `days` días.
    Una configuración sin fecha de edición y sin uso conocido cuenta como sin uso."""
    cutoff = now - datetime.timedelta(days=days)
    out = []
    for cfg_id, edited in modified.items():
        recent = max((t for t in (edited, last_used.get(cfg_id)) if t), default=None)
        if recent is None or recent < cutoff:
            out.append(cfg_id)
    return sorted(out)


def read_records(r2):
    for key in r2.keys('short/'):
        got = r2.get(key)
        if not got:
            continue
        try:
            yield json.loads(got[0])
        except ValueError:
            continue


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', default=os.path.join('out', 'idle.json'))
    ap.add_argument('--days', type=int, default=IDLE_DAYS)
    args = ap.parse_args(argv)
    needed = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if not all(os.environ.get(k) for k in needed):
        print('ℹ️  Sin credenciales de R2: no se calcula el uso (se arman todas las guías)')
        return 0
    import boto3
    client = boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')
    bucket = os.environ.get('R2_BUCKET') or 'grilla'
    modified = {}
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='cfg/'):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if key.endswith('.json') and '/' not in key[len('cfg/'):]:
                modified[key[len('cfg/'):-len('.json')]] = obj['LastModified']
    last = last_used_by_config(read_records(R2(client, bucket)))
    now = datetime.datetime.now(datetime.timezone.utc)
    idle = idle_configs(modified, last, now, args.days)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump({'days': args.days, 'configs': idle, 'total': len(modified)}, f, indent=1)
    print(f"💤 {len(idle)} de {len(modified)} configuración(es) sin uso hace más de {args.days} días")
    return 0


if __name__ == '__main__':
    sys.exit(main())
