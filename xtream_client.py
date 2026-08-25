#!/usr/bin/env python3
"""Cliente mínimo de la API Xtream Codes con failover entre varios servidores."""
import requests


class XtreamError(Exception):
    pass


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
            print(f"✅ Servidor activo: {_server_host(server)} ({len(data)} canales)")
            return server, data
        except Exception as e:
            print(f"❌ Servidor caído {_server_host(server)}: {e}")
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
        print(f"⚠️  No se pudieron obtener las categorías: {e}")
        return {}


def build_stream_url(server, username, password, stream_id, container_extension='m3u8'):
    ext = container_extension or 'm3u8'
    return f"{server.rstrip('/')}/live/{username}/{password}/{stream_id}.{ext}"
