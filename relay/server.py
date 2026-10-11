#!/usr/bin/env python3
"""Relay de Grilla: pide al proveedor IPTV lo que el Worker no puede pedir.

El proveedor bloquea los pedidos que salen de Cloudflare. En vez de depender de un secret por persona en GitHub,
el Worker (que ya tiene las credenciales de cada persona, cifradas en sus links) le pide al relay que haga el pedido
desde un servidor cuya IP el proveedor no bloquea. El relay no guarda nada: recibe usuario y contraseña en cada
pedido, los usa y los descarta. Nunca los escribe en el log.

Se autentica con un secret compartido con el Worker (RELAY_SECRET, mínimo 32 caracteres):
  POST /v1/list     {servers, username, password}            -> {server, channels}
  POST /v1/account  {servers, username, password}            -> {server, account}
  POST /v1/probe    {servers, username, password, channels}  -> {server, account, results, res, aborted}
                    (los canales con "res": true que anden también se miden, con el mismo pedido: res[id] = [ancho, alto] o null)
  GET  /health                                              -> {ok: true}   (sin autenticar)

Cuidados:
- Solo habla con servidores públicos (http/https, sin IPs privadas ni locales): el relay no es una puerta a otra red.
- Un pedido por cuenta a la vez (los proveedores limitan las conexiones simultáneas) y pocos en total.
- Topes de tamaño del pedido, de canales por prueba y de tiempo.
"""
import datetime
import hashlib
import hmac
import ipaddress
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402

import video_res  # noqa: E402
import xtream_client  # noqa: E402
from xtream_client import (REJECTS_TO_ABORT, XtreamError, build_stream_url, get_live_categories, get_live_streams,  # noqa: E402
                           pick_server, probe, worker_channels)

# Sin avisos de progreso del cliente Xtream: sus errores pueden llevar la URL con usuario y contraseña.
xtream_client.LOG = lambda *args, **kwargs: None

MIN_SECRET_LEN = 32
MAX_BODY = 64 * 1024
MAX_SERVERS = 20
MAX_PROBE_CHANNELS = 60
PROBE_BUDGET_S = 45
# Medir la resolución lleva unos segundos por canal: no se empieza una medición con menos de esto por delante.
MEASURE_RESERVE_S = 10
MAX_CONCURRENT = 4

_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_account_locks = {}
_account_locks_guard = threading.Lock()


class BadRequest(Exception):
    pass


def _lock_for(username, password):
    key = hashlib.sha256(f'{username}\n{password}'.encode('utf-8')).hexdigest()
    with _account_locks_guard:
        if len(_account_locks) > 5000:
            _account_locks.clear()
        return _account_locks.setdefault(key, threading.Lock())


def is_public_host(host, resolve=socket.getaddrinfo):
    """El nombre o la IP apuntan solo a direcciones públicas (nada privado, local, de enlace ni reservado)."""
    try:
        infos = resolve(host, None)
    except OSError:
        return False
    addrs = {info[4][0] for info in infos}
    if not addrs:
        return False
    for addr in addrs:
        try:
            ip = ipaddress.ip_address(addr.split('%')[0])
        except ValueError:
            return False
        if not ip.is_global:
            return False
    return True


def clean_credentials(body, resolve=socket.getaddrinfo):
    """(servidores, usuario, contraseña) validados, o BadRequest."""
    servers = body.get('servers')
    if not isinstance(servers, list) or not servers or len(servers) > MAX_SERVERS:
        raise BadRequest('servidores inválidos')
    out = []
    for s in servers:
        if not isinstance(s, str):
            raise BadRequest('servidores inválidos')
        parts = urlsplit(s.strip())
        if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.query:
            raise BadRequest('servidor inválido')
        if not is_public_host(parts.hostname, resolve):
            raise BadRequest('servidor no permitido')
        out.append(s.strip().rstrip('/'))
    user, password = body.get('username'), body.get('password')
    if not isinstance(user, str) or not isinstance(password, str) or not user or len(user) > 200 or len(password) > 200:
        raise BadRequest('faltan usuario y contraseña')
    return out, user, password


def do_list(servers, user, password):
    server, streams = get_live_streams(servers, user, password)
    return {'server': server, 'channels': worker_channels(streams, get_live_categories(server, user, password))}


def do_account(servers, user, password, pick=None):
    server, account = (pick or pick_server)(servers, user, password)
    if not server:
        raise XtreamError('sin servidor')
    return {'server': server, 'account': account}


def do_probe(servers, user, password, channels, pick=None, prober=None, measurer=None, clock=time.monotonic,
             budget_s=PROBE_BUDGET_S):
    if not isinstance(channels, list) or not channels or len(channels) > MAX_PROBE_CHANNELS:
        raise BadRequest('canales inválidos')
    items = []
    for ch in channels:
        cid = str(ch.get('id') or '') if isinstance(ch, dict) else ''
        ext = str(ch.get('ext') or 'm3u8') if isinstance(ch, dict) else ''
        if not cid or len(cid) > 40 or not ext.isalnum() or len(ext) > 8:
            raise BadRequest('canales inválidos')
        items.append((cid, ext, isinstance(ch, dict) and ch.get('res') is True))
    info = do_account(servers, user, password, pick)
    session = requests.Session()
    prober = prober or (lambda url: probe(session, url))
    # Probar y medir con un solo pedido: una segunda conexión enseguida puede rebotar por el límite de conexiones.
    measurer = measurer or (lambda url: probe(session, url, lambda r, head: video_res.measure(session, url, first=(r, head))))
    results, res, rejects, started = {}, {}, 0, clock()
    aborted = False
    for cid, ext, want_res in items:
        if clock() - started > budget_s:
            break
        url = build_stream_url(info['server'], user, password, cid, ext)
        wh = None
        measuring = want_res and budget_s - (clock() - started) > MEASURE_RESERVE_S
        if measuring:
            result, wh = measurer(url)
        else:
            result = prober(url)
        if result == 'rejected':
            rejects += 1
            if rejects >= REJECTS_TO_ABORT:
                aborted = True  # la cuenta rechaza: no es el canal
                results = {}
                break
            continue
        rejects = 0
        results[cid] = result
        if measuring and result == 'up':
            res[cid] = list(wh) if wh else None
    return {**info, 'results': results, 'res': {} if aborted else res, 'aborted': aborted}


def authorized(header, secret):
    token = header[7:] if header.startswith('Bearer ') else ''
    return bool(secret) and hmac.compare_digest(token.encode('utf-8'), secret.encode('utf-8'))


class Handler(BaseHTTPRequestHandler):
    secret = ''
    resolve = staticmethod(socket.getaddrinfo)

    def log_message(self, fmt, *args):  # nunca el cuerpo ni la URL completa: llevan datos de la cuenta
        sys.stderr.write(f'{self.command} {self.path.split("?")[0]} {args[1] if len(args) > 1 else ""}\n')

    def _send(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, {'ok': True})
        self._send(404, {'error': 'no encontrado'})

    def do_POST(self):
        if not authorized(self.headers.get('Authorization', ''), self.secret):
            return self._send(401, {'error': 'no autorizado'})
        route = {'/v1/list': 'list', '/v1/account': 'account', '/v1/probe': 'probe'}.get(self.path)
        if not route:
            return self._send(404, {'error': 'no encontrado'})
        try:
            size = int(self.headers.get('Content-Length') or 0)
            if size <= 0 or size > MAX_BODY:
                raise BadRequest('pedido demasiado grande')
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise BadRequest('pedido inválido')
            servers, user, password = clean_credentials(body, self.resolve)
        except (BadRequest, ValueError) as e:
            return self._send(400, {'error': str(e) if isinstance(e, BadRequest) else 'JSON inválido'})
        if not _slots.acquire(timeout=5):
            return self._send(503, {'error': 'ocupado, probá de nuevo'})
        try:
            with _lock_for(user, password):
                if route == 'list':
                    out = do_list(servers, user, password)
                elif route == 'account':
                    out = do_account(servers, user, password)
                else:
                    out = do_probe(servers, user, password, body.get('channels'))
            self._send(200, out)
        except BadRequest as e:
            self._send(400, {'error': str(e)})
        except (XtreamError, requests.RequestException):
            # Sin detalles: la URL del proveedor lleva las credenciales.
            self._send(502, {'error': 'el proveedor no respondió'})
        finally:
            _slots.release()


def make_server(secret, host='0.0.0.0', port=8080):
    if len(secret or '') < MIN_SECRET_LEN:
        raise SystemExit(f'RELAY_SECRET falta o tiene menos de {MIN_SECRET_LEN} caracteres')
    handler = type('H', (Handler,), {'secret': secret})
    return ThreadingHTTPServer((host, port), handler)


if __name__ == '__main__':
    srv = make_server(os.environ.get('RELAY_SECRET', ''), port=int(os.environ.get('PORT') or 8080))
    print(f'relay escuchando en el puerto {srv.server_address[1]}')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:  # la plataforma lo apaga con una señal: no es un error
        pass
    finally:
        srv.server_close()
