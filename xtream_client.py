#!/usr/bin/env python3
"""Cliente mínimo de la API Xtream Codes con failover entre varios servidores."""
import datetime
import re

import requests


class XtreamError(Exception):
    pass


# Dónde van los avisos de progreso. El relay lo apaga: un mensaje de error de requests puede llevar la URL completa, con usuario y contraseña.
LOG = print


def _server_host(server):
    """Devuelve el servidor sin credenciales, solo para logging seguro."""
    return server.split('//')[-1].split('/')[0]


def get_live_streams(servers, username, password, timeout=15):
    """Prueba cada servidor en orden y devuelve (server_usado, lista_de_canales)."""
    last_error = None

    for server in servers:
        server = server.rstrip('/')
        url = f"{server}/player_api.php"
        params = {
            'username': username,
            'password': password,
            'action': 'get_live_streams',
        }
        try:
            response = requests.get(url, params=params, timeout=timeout)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, list):
                raise XtreamError(f"Respuesta inesperada del servidor ({type(data).__name__})")
            LOG(f"✅ Servidor activo: {_server_host(server)} ({len(data)} canales)")
            return server, data
        except Exception as e:
            LOG(f"❌ Servidor caído {_server_host(server)}: {e}")
            last_error = e
            continue

    raise XtreamError(f"Los {len(servers)} servidores fallaron. Último error: {last_error}")


def get_live_categories(server, username, password, timeout=15):
    """Devuelve {category_id: category_name} desde el servidor ya confirmado activo."""
    url = f"{server.rstrip('/')}/player_api.php"
    params = {
        'username': username,
        'password': password,
        'action': 'get_live_categories',
    }
    try:
        response = requests.get(url, params=params, timeout=timeout)
        response.raise_for_status()
        data = response.json()
        return {str(c['category_id']): c['category_name'] for c in data}
    except Exception as e:
        LOG(f"⚠️  No se pudieron obtener las categorías: {e}")
        return {}


def build_stream_url(server, username, password, stream_id, container_extension='m3u8'):
    ext = container_extension or 'm3u8'
    return f"{server.rstrip('/')}/live/{username}/{password}/{stream_id}.{ext}"


# Para el relay (relay/server.py) y tools/grilla_home.py: la lista en el formato del Worker, los datos de la cuenta y
# la prueba de un stream.
# Si el proveedor contesta varias veces seguidas con rechazo (usuario, límite de conexiones), no es el canal: es la cuenta.
REJECTS_TO_ABORT = 4
CONNECT_TIMEOUT, READ_TIMEOUT = 8, 8


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


_TZ_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}$')


def account_info(data):
    """Datos de la cuenta que se publican (lista blanca: la respuesta trae también usuario y contraseña)."""
    info = (data or {}).get('user_info') if isinstance(data, dict) else None
    if not isinstance(info, dict):
        return None
    out = {}
    if isinstance(info.get('status'), str):
        out['status'] = info['status'][:30]
    try:
        exp = int(str(info.get('exp_date')))
        out['expires'] = datetime.datetime.fromtimestamp(exp, datetime.timezone.utc).isoformat(timespec='seconds') if exp > 0 else None
    except (TypeError, ValueError, OverflowError, OSError):
        out['expires'] = None
    out['trial'] = str(info.get('is_trial')) == '1'
    try:
        out['maxConnections'] = int(str(info.get('max_connections')))
    except (TypeError, ValueError):
        pass
    try:
        out['activeConnections'] = int(str(info.get('active_cons')))
    except (TypeError, ValueError):
        pass
    # La zona horaria del panel (la que se elige en el proveedor): es la de las horas que van en el nombre de los eventos.
    server = data.get('server_info')
    tz = server.get('timezone') if isinstance(server, dict) else None
    if isinstance(tz, str) and len(tz) <= 64 and _TZ_RE.match(tz.strip()):
        out['timezone'] = tz.strip()
    return out


def pick_server(servers, username, password):
    """(servidor, datos de la cuenta) del primer servidor que contesta a la API (pedido chico: no baja la lista)."""
    for server in servers:
        try:
            r = requests.get(f"{server.rstrip('/')}/player_api.php", params={'username': username, 'password': password}, timeout=15)
            if r.status_code == 200:
                try:
                    data = r.json()
                except ValueError:
                    data = None
                return server.rstrip('/'), account_info(data)
        except requests.RequestException:
            continue
    return None, None


REJECT_STATUS = (401, 403, 407, 429, 458, 884)


def probe(session, url, measure=None):
    """'up', 'down' o 'rejected' (la cuenta, no el canal: usuario, límite de conexiones, bloqueo).

    Con `measure(response, head)`, si el canal anda se le pasa la misma conexión abierta y devuelve (resultado, medida)."""
    try:
        with session.get(url, stream=True, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT), allow_redirects=True) as r:
            if r.status_code in REJECT_STATUS:
                return ('rejected', None) if measure else 'rejected'
            if r.status_code != 200:
                return ('down', None) if measure else 'down'
            head = next(r.iter_content(4096 if measure else 1024), b'')
            up = b'#EXTM3U' in head or head[:1] == b'\x47'
            if not measure:
                return 'up' if up else 'down'
            return ('up', measure(r, head)) if up else ('down', None)
    except requests.RequestException:
        return ('down', None) if measure else 'down'
