#!/usr/bin/env python3
"""Perfiles de acceso Xtream: una persona = un perfil.

La parte cara del pipeline (fusionar las fuentes EPG y decidir qué tvg-id le corresponde a
cada canal del proveedor) es idéntica para todo el mundo. Lo único que cambia entre personas
son el usuario y la contraseña que van dentro de la URL del stream. Por eso `merged.xml.gz`
se genera una sola vez y después se recorren los perfiles.

Se configura con un único secret `XTREAM_PROFILES` (JSON), así agregar a alguien es editar
ese secret y no tocar el workflow. Si no está, se cae a las variables sueltas de siempre.
"""
import json
import os
import re

PROFILES_ENV = 'XTREAM_PROFILES'

# Cada perfil escribe sus artefactos en out/<nombre>/.
OUTPUT_DIR = 'out'

# El nombre del perfil termina siendo parte de rutas y nombres de archivo publicados.
SAFE_NAME_RE = re.compile(r'^[A-Za-z0-9_-]+$')


def _clean_servers(raw):
    if isinstance(raw, str):
        raw = raw.split(',')
    return [s.strip().rstrip('/') for s in (raw or []) if s and s.strip()]


def _build(name, username, password, servers, gist_id=None):
    return {
        'name': name,
        'username': username,
        'password': password,
        'servers': servers,
        'gist_id': gist_id,
    }


def load_profiles(env=None):
    """Devuelve la lista de perfiles configurados (vacía si no hay ninguno).

    Nunca imprime credenciales: los errores se reportan por nombre de perfil.
    """
    env = os.environ if env is None else env

    raw = (env.get(PROFILES_ENV) or '').strip()
    if not raw:
        username = env.get('XTREAM_USERNAME')
        password = env.get('XTREAM_PASSWORD')
        servers = _clean_servers(env.get('XTREAM_SERVERS', ''))
        if username and password and servers:
            # XTREAM_GIST_ID permite publicar en un gist sin tener que migrar las credenciales
            # a XTREAM_PROFILES: con un solo usuario, las variables sueltas alcanzan.
            return [_build('default', username, password, servers,
                           env.get('XTREAM_GIST_ID'))]
        return []

    try:
        entries = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"❌ {PROFILES_ENV} no es JSON válido ({e}); no se genera ninguna playlist")
        return []

    if isinstance(entries, dict):
        entries = [entries]
    if not isinstance(entries, list):
        print(f"❌ {PROFILES_ENV} debe ser una lista de perfiles")
        return []

    profiles, seen = [], set()
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            print(f"⚠️  Perfil #{i + 1} ignorado: no es un objeto")
            continue
        name = str(entry.get('name') or f'perfil{i + 1}')
        if not SAFE_NAME_RE.match(name):
            print(f"⚠️  Perfil #{i + 1} ignorado: el nombre {name!r} debe ser letras, números, '-' o '_'")
            continue
        if name in seen:
            print(f"⚠️  Perfil {name!r} ignorado: nombre repetido")
            continue
        username = entry.get('username')
        password = entry.get('password')
        servers = _clean_servers(entry.get('servers'))
        if not username or not password or not servers:
            print(f"⚠️  Perfil {name!r} ignorado: faltan username, password o servers")
            continue
        seen.add(name)
        profiles.append(_build(name, username, password, servers, entry.get('gist_id')))

    return profiles
