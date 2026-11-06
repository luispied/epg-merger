#!/usr/bin/env python3
"""Pide a mano la medición de canales (caídos y calidad/fps): deja el mismo pedido que el botón «Probar canales»
de la app, healthreq/<cfgId>.json en R2. El cron del Worker (cada 30 minutos) lo toma y prueba la configuración
por el relay, sin esperar las 20 horas.

Sin `CFG` pide la medición de todas las configuraciones con dispositivos (las de devices/). Con `CFG` (un id o
el comienzo del id, como en «Borrar configuración») pide solo esa, y tiene que coincidir con una sola.

No toca short/ ni devices/, no rota TOKEN_KEY y no cambia la configuración: solo escribe healthreq/.

Uso: `CFG=<id o comienzo> python tools/pedir_medicion.py` (con las variables de R2), o el workflow
«Medir canales a mano».
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from r2 import R2  # noqa: E402


def pedir_medicion(r2, ahora, prefijo=''):
    """Escribe healthreq/ para las configuraciones que correspondan. Devuelve la lista de cfgId pedidos.
    Error si el prefijo (con texto) no identifica una sola configuración."""
    prefijo = prefijo.strip()
    ids = sorted({k[len('devices/'):-len('.json')] for k in r2.keys('devices/') if k.endswith('.json')})
    if prefijo:
        if len(prefijo) < 4:
            raise ValueError('poné al menos 4 caracteres del id')
        ids = [i for i in ids if i.startswith(prefijo)]
        if len(ids) != 1:
            raise ValueError(f'"{prefijo}" coincide con {len(ids)} configuraciones (tiene que ser una)')
    if not ids:
        raise ValueError('no hay configuraciones con dispositivos (devices/)')
    cuerpo = json.dumps({'at': ahora.isoformat().replace('+00:00', 'Z')})
    for cfg_id in ids:
        r2.put(f'healthreq/{cfg_id}.json', cuerpo.encode('utf-8'))
    return ids


def main():
    prefijo = os.environ.get('CFG', '')
    necesarias = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if not all(os.environ.get(k) for k in necesarias):
        print('❌ Faltan las credenciales de R2')
        return 1
    import boto3
    cliente = boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')
    try:
        ids = pedir_medicion(R2(cliente, os.environ.get('R2_BUCKET') or 'grilla'),
                             datetime.datetime.now(datetime.timezone.utc), prefijo)
    except ValueError as e:
        print(f'❌ {e}')
        return 1
    print(f'✅ Medición pedida para {len(ids)} configuración(es). El cron del Worker la toma en hasta 30 minutos.')
    for cfg_id in ids:
        print(f'- {cfg_id}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
