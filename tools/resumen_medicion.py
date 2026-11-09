#!/usr/bin/env python3
"""Resume, en cantidades, cómo está la medición de canales (health/<cfgId>.json en R2): cuántos canales tienen
resolución, cuántos tienen fps, cuántos se midieron de nuevo desde el último pedido y cómo se reparten los fps.
Solo lee: no escribe en R2, no toca short/ ni devices/, y no imprime nombres de canales, cuentas ni credenciales.

Uso: `python tools/resumen_medicion.py` (con las variables de R2), o el workflow «Resumen de medición».
"""
import collections
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from r2 import R2  # noqa: E402


def _t(valor):
    try:
        return datetime.datetime.fromisoformat(str(valor).replace('Z', '+00:00')).timestamp()
    except ValueError:
        return 0.0


def resumen(health, pedido, progreso=None, guardado=None):
    """Cantidades de una configuración. `health`, `pedido` y `progreso` (healthprog/, que queda solo si una prueba
    se cortó a medias) son los JSON ya leídos (o None); `guardado` es cuándo se escribió health/ por última vez."""
    health = health or {}
    pedido = pedido or {}
    progreso = progreso or {}
    res = health.get('res') or {}
    desde = _t(pedido.get('at')) if pedido.get('remedir') else 0.0
    con_medida = [r for r in res.values() if r.get('w') and r.get('h')]
    con_fps = [r for r in con_medida if r.get('f')]
    caidos = sum(1 for e in (health.get('channels') or {}).values() if not e.get('ok'))
    return {
        'ultima_prueba': health.get('attempted'),
        'ultima_prueba_completa': health.get('checked'),
        'relay_respondio': health.get('relayOk'),
        'relay_fallo': health.get('relayFail'),
        'health_guardado': guardado,
        'probados_en_la_ultima': health.get('tested'),
        'prueba_a_medias': ({k: progreso.get(k) for k in ('started', 'at', 'done', 'total', 'down')} if progreso else None),
        'pedido': pedido.get('at'),
        'pedido_remedir': bool(pedido.get('remedir')),
        'canales_probados': len(health.get('channels') or {}),
        'caidos': caidos,
        'con_resolucion': len(con_medida),
        'sin_resolucion': len(res) - len(con_medida),
        'con_fps': len(con_fps),
        'version_2': sum(1 for r in con_medida if r.get('v') == 2),
        'medidos_desde_el_pedido': sum(1 for r in res.values() if desde and _t(r.get('t')) >= desde),
        'medidos_antes_del_pedido': sum(1 for r in res.values() if desde and _t(r.get('t')) < desde),
        'fps': dict(collections.Counter(round(r['f']) for r in con_fps).most_common(8)),
        'alturas': dict(collections.Counter(r['h'] for r in con_medida).most_common(8)),
    }


def main():
    necesarias = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if not all(os.environ.get(k) for k in necesarias):
        print('❌ Faltan las credenciales de R2')
        return 1
    import boto3
    cliente = boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')
    r2 = R2(cliente, os.environ.get('R2_BUCKET') or 'grilla')
    ahora = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    print(f'Resumen de medición, {ahora}\n')
    ids = sorted({k[len('devices/'):-len('.json')] for k in r2.keys('devices/') if k.endswith('.json')})
    for n, cfg_id in enumerate(ids, 1):
        got = r2.get(f'health/{cfg_id}.json')
        req = r2.get(f'healthreq/{cfg_id}.json')
        prog = r2.get(f'healthprog/{cfg_id}.json')
        datos = resumen(json.loads(got[0]) if got else None, json.loads(req[0]) if req else None,
                        json.loads(prog[0]) if prog else None,
                        got[1].isoformat(timespec='seconds') if got else None)
        print(f'### Configuración {n}' + ('' if got else ' (sin health/)'))
        for k, v in datos.items():
            print(f'- {k}: {v}')
        print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
