#!/usr/bin/env python3
"""Borra una configuración de Grilla web de R2, con todo lo suyo: la configuración, su lista,
su guía, su comparación, sus links cortos y su anotación en las cuentas enlazadas.

Para limpiar configuraciones de prueba. Se le pasa el id o el comienzo del id (como lo muestra
"Compare Grilla web", p. ej. `-wPXj0`); tiene que coincidir con una sola configuración.
Los links de reproducción de esa configuración dejan de funcionar.

Uso: `CFG=<id o comienzo> python tools/delete_cfg.py` (con las variables de R2), o el workflow
"Delete Grilla config".
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from push_lists import R2  # noqa: E402


def delete_config(r2, prefix):
    """Devuelve (cfgId, [claves borradas]). Error si el comienzo no identifica una sola."""
    prefix = prefix.strip()
    if len(prefix) < 4:
        raise ValueError('poné al menos 4 caracteres del id')
    matches = [k[len('cfg/'):-len('.json')] for k in r2.keys(f'cfg/{prefix}') if k.endswith('.json')]
    if len(matches) != 1:
        raise ValueError(f'"{prefix}" coincide con {len(matches)} configuraciones (tiene que ser una)')
    cfg_id = matches[0]
    deleted = []
    for key in (f'cfg/{cfg_id}.json', f'list/{cfg_id}.json', f'epg/{cfg_id}.xml.gz', f'compare/{cfg_id}.json'):
        if r2.get(key) is not None:
            r2.delete(key)
            deleted.append(key)
    for key in list(r2.keys('short/')):
        got = r2.get(key)
        if got and json.loads(got[0] or b'{}').get('cfgId') == cfg_id:
            r2.delete(key)
            deleted.append(key)
    for key in list(r2.keys('links/')):
        got = r2.get(key)
        data = json.loads(got[0] or b'{}') if got else {}
        if cfg_id in data.get('cfgIds', []):
            data['cfgIds'] = [c for c in data['cfgIds'] if c != cfg_id]
            r2.put(key, json.dumps(data).encode('utf-8'))
            deleted.append(f'{key} (enlace)')
    return cfg_id, deleted


def main():
    prefix = os.environ.get('CFG', '')
    needed = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if not all(os.environ.get(k) for k in needed):
        print('❌ Faltan las credenciales de R2')
        return 1
    import boto3
    client = boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')
    try:
        cfg_id, deleted = delete_config(R2(client, os.environ.get('R2_BUCKET') or 'grilla'), prefix)
    except ValueError as e:
        print(f'❌ {e}')
        return 1
    print(f'🗑️  Configuración {cfg_id[:6]}… borrada:')
    for key in deleted:
        print(f'   - {key.replace(cfg_id, cfg_id[:6] + "…")}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
