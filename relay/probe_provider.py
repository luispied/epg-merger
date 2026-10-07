#!/usr/bin/env python3
"""¿Este servidor llega al proveedor? Prueba una plataforma antes de publicar el relay ahí, sin credenciales.

Se corre EN el servidor candidato (por ejemplo `fly ssh console` y `python probe_provider.py`, una VM de Oracle, un VPS, una
máquina de tu casa) con la dirección del proveedor en una variable de entorno, así no se escribe en ningún chat ni archivo:

    PROVIDER_URL=http://servidor.ejemplo:8080 python3 probe_provider.py

Pide `player_api.php` SIN usuario ni contraseña. Un proveedor que acepta la IP contesta (un JSON de «no autorizado», 200 o 401);
uno que la bloquea corta la conexión, no contesta o responde 403/429/5xx. No imprime la dirección del proveedor.
Sirve para comparar: desde Cloudflare falla, desde GitHub anda; la plataforma que elijas tiene que andar como GitHub.
"""
import json
import os
import sys
import time

import requests

TIMEOUT = 12


def classify(status, body):
    """('alcanzable'|'bloqueado'|'dudoso', motivo) a partir de la respuesta del proveedor sin credenciales."""
    if status in (200, 401):
        try:
            data = json.loads(body)
        except ValueError:
            data = None
        if isinstance(data, dict) and ('user_info' in data or 'server_info' in data):
            return 'alcanzable', 'el proveedor contesta a la API'
        return 'dudoso', f'respondió {status} pero no es la API de Xtream (¿una página de bloqueo?)'
    if status in (403, 429, 451, 458, 884):
        return 'bloqueado', f'el proveedor rechaza este origen (HTTP {status})'
    if status >= 500:
        return 'dudoso', f'error del proveedor o del intermediario (HTTP {status})'
    return 'dudoso', f'respuesta inesperada (HTTP {status})'


def probe(url, get=requests.get, clock=time.monotonic):
    base = url.strip().rstrip('/')
    started = clock()
    try:
        r = get(f'{base}/player_api.php', timeout=TIMEOUT, allow_redirects=False)
    except requests.exceptions.ConnectTimeout:
        return {'result': 'bloqueado', 'reason': 'no hubo conexión a tiempo (suele ser un bloqueo por IP)', 'ms': None}
    except requests.exceptions.ConnectionError:
        return {'result': 'bloqueado', 'reason': 'conexión cortada o rechazada (suele ser un bloqueo por IP)', 'ms': None}
    except requests.RequestException as e:
        return {'result': 'dudoso', 'reason': f'error de red ({type(e).__name__})', 'ms': None}
    result, reason = classify(r.status_code, r.text[:2000])
    return {'result': result, 'reason': reason, 'ms': round((clock() - started) * 1000)}


def main():
    url = os.environ.get('PROVIDER_URL', '')
    if not url.startswith(('http://', 'https://')):
        print('Falta PROVIDER_URL (por ejemplo PROVIDER_URL=http://servidor.ejemplo:8080)')
        return 2
    out = probe(url)
    print(f"Resultado: {out['result'].upper()} — {out['reason']}" + (f" ({out['ms']} ms)" if out['ms'] is not None else ''))
    return 0 if out['result'] == 'alcanzable' else 1


if __name__ == '__main__':
    sys.exit(main())
