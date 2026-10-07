#!/usr/bin/env python3
"""Canales caídos para Grilla web, probados desde GitHub (workflow check-streams.yml).

El proveedor de Luis bloquea los pedidos que salen de Cloudflare, así que el Worker no puede probar los
streams: GitHub sí. Una vez por día prueba una tanda de canales de cada cuenta anotada (la misma que usa
push_lists.py para la lista) y deja el resultado en `health/<cfgId>.json`, que la web lee para marcar los
canales caídos. Es solo un aviso: no oculta nada.

Cuidados con el proveedor y con los minutos de Actions:
- Una tanda de BATCH canales por corrida, los que hace más que no se prueban (los nunca probados primero):
  la lista entera se recorre en unos días, no de una vez.
- Un pedido por vez (los proveedores limitan las conexiones simultáneas) y se corta cada uno al recibir los
  primeros bytes: no se baja video.
- Tope de tiempo por corrida; y si el proveedor contesta varias veces seguidas con rechazo (usuario,
  límite de conexiones), se corta sin anotar nada: no es el canal, es la cuenta.
- Nunca imprime URLs ni credenciales.

Un canal está «caído» cuando falló DOWN_AFTER pruebas seguidas (lo decide la web con `fails`).

De paso, la misma respuesta de la API que elige el servidor trae los datos de la cuenta (vencimiento,
conexiones): se guardan en `account` (solo esos campos, nunca el usuario ni la contraseña) para que la web
los muestre y el Worker avise antes de que venza.
"""
import datetime
import json
import os
import re
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import push_lists  # noqa: E402
from profiles import load_profiles  # noqa: E402
from xtream_client import build_stream_url  # noqa: E402

BATCH = 200
# Largo de la huella de la cuenta (primeros caracteres del hash de usuario y contraseña) que identifica sus datos en health/.
ACCOUNT_KEY_LEN = 12
# Una sola prueba por día (sea la de la madrugada o una lanzada a mano): si la última fue hace menos que esto, se saltea.
MIN_INTERVAL = datetime.timedelta(hours=20)
TIME_BUDGET_S = 300
REJECTS_TO_ABORT = 4
CONNECT_TIMEOUT, READ_TIMEOUT = 8, 8

DIVIDER_RE = re.compile('[▀-▟]{2,}')
# Eventos sueltos (PPV, partidos): la mayor parte del día no emiten y no es que estén caídos.
EVENT_RE = re.compile(r'ppv|event', re.IGNORECASE)


def visible_channels(channels, cfg):
    """Canales que vale la pena probar: no ocultos, ni separadores ni eventos sueltos."""
    edits = (cfg or {}).get('channels') or {}
    hidden_groups = set(((cfg or {}).get('groups') or {}).get('hidden') or [])
    out = []
    for ch in channels:
        edit = edits.get(ch['name']) or {}
        group = edit.get('group') or ch['category']
        if edit.get('hidden') or group in hidden_groups:
            continue
        if DIVIDER_RE.search(ch['category']) or EVENT_RE.search(ch['category']) or EVENT_RE.search(group):
            continue
        out.append(ch)
    return out


def pick_batch(channels, state, n=BATCH):
    """Los n canales que hace más que no se prueban (los que nunca se probaron, primero)."""
    seen = state.get('channels') or {}
    ordered = sorted(channels, key=lambda ch: (seen.get(ch['id'], {}).get('t', ''), ch['id']))
    return ordered[:n]


def probe(session, url):
    """'up', 'down' o 'rejected' (la cuenta, no el canal: usuario, límite de conexiones, bloqueo)."""
    try:
        with session.get(url, stream=True, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT), allow_redirects=True) as r:
            if r.status_code in (401, 403, 429, 458, 884) or r.status_code == 407:
                return 'rejected'
            if r.status_code != 200:
                return 'down'
            head = next(r.iter_content(1024), b'')
            return 'up' if (b'#EXTM3U' in head or head[:1] == b'\x47') else 'down'
    except requests.RequestException:
        return 'down'


def check(channels, state, url_for, prober, now, budget_s=TIME_BUDGET_S, batch=BATCH, clock=time.monotonic):
    """Prueba una tanda y devuelve el estado nuevo. `url_for(ch)` arma la URL (con credenciales: no se imprime)."""
    known = {ch['id'] for ch in channels}
    old = {k: v for k, v in (state.get('channels') or {}).items() if k in known}
    new = dict(old)
    started, rejects, tested = clock(), 0, 0
    for ch in pick_batch(channels, {'channels': old}, batch):
        if clock() - started > budget_s:
            break
        result = prober(url_for(ch))
        if result == 'rejected':
            rejects += 1
            if rejects >= REJECTS_TO_ABORT:
                return None  # la cuenta rechaza: no es el canal, no se anota nada
            continue
        rejects = 0
        prev = old.get(ch['id'], {})
        ok = result == 'up'
        new[ch['id']] = {'t': now.isoformat(timespec='seconds'), 'ok': ok, 'fails': 0 if ok else prev.get('fails', 0) + 1}
        tested += 1
    return {'checked': now.isoformat(timespec='seconds'), 'tested': tested, 'total': len(channels), 'channels': new}


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
    return out


def recent(state, now):
    """¿La última prueba de canales fue hace menos de MIN_INTERVAL?"""
    try:
        last = datetime.datetime.fromisoformat(state.get('checked') or '')
    except ValueError:
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=datetime.timezone.utc)
    return now - last < MIN_INTERVAL


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


def run(r2, profiles, prober=None, now=None, server_for=None):
    """Prueba una tanda por cuenta anotada. Devuelve {perfil: (probados, caídos)}."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    done = {}
    for profile in profiles:
        h = push_lists.link_hash(profile['username'], profile['password'])
        link = r2.get(f'links/{h}.json')
        if link is None:
            continue
        cfg_ids = [c for c in json.loads(link[0] or b'{}').get('cfgIds', []) if r2.get(f'cfg/{c}.json') is not None]
        if not cfg_ids:
            continue
        lst = r2.get(f'list/{cfg_ids[0]}.json')
        cfg = r2.get(f'cfg/{cfg_ids[0]}.json')
        if lst is None:
            continue
        channels = visible_channels(json.loads(lst[0]).get('channels', []), json.loads(cfg[0]) if cfg else {})
        servers = push_lists.servers_from_config(r2, cfg_ids, profile['servers'])
        server, account = (server_for or pick_server)(servers, profile['username'], profile['password'])
        if not server:
            continue
        previous = r2.get(f'health/{cfg_ids[0]}.json')
        state = json.loads(previous[0]) if previous else {}
        # Los datos de cada cuenta (vencimiento, conexiones) van por huella, para mostrar el de cada una; `account`
        # queda con los de la primera cuenta de la configuración (la principal), que es la que avisa del vencimiento.
        key = h[:ACCOUNT_KEY_LEN]
        accounts = dict(state.get('accounts') or {})
        if account is not None:
            accounts[key] = account
        if recent(state, now):
            print(f"ℹ️  {profile['name']}: ya se probó hace menos de {int(MIN_INTERVAL.total_seconds() // 3600)} horas, se saltea")
            if account is not None and accounts != (state.get('accounts') or {}):
                body = json.dumps({**state, 'accounts': accounts}, ensure_ascii=False).encode('utf-8')
                for cfg_id in cfg_ids:
                    r2.put(f'health/{cfg_id}.json', body)
            continue
        new = None
        if channels:
            session = requests.Session()
            ext = {ch['id']: ch.get('ext') for ch in channels}
            new = check(channels, state, lambda ch: build_stream_url(server, profile['username'], profile['password'], ch['id'], ext[ch['id']]),
                        prober or (lambda url: probe(session, url)), now)
        # Si la cuenta rechazó las pruebas (new es None) igual se actualiza el vencimiento, sin tocar los canales.
        out = dict(new if new is not None else state)
        out.setdefault('channels', {})
        if account is not None:
            out['account'] = account
            out['accounts'] = accounts
        if new is None and account is None:
            continue
        body = json.dumps(out, ensure_ascii=False).encode('utf-8')
        for cfg_id in cfg_ids:
            r2.put(f'health/{cfg_id}.json', body)
        down = sum(1 for v in out['channels'].values() if not v['ok'] and v['fails'] >= 2)
        done[profile['name']] = (new['tested'] if new is not None else 0, down)
    return done


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
    profiles = [p for p in load_profiles() if p.get('type', 'xtream') == 'xtream']
    done = run(push_lists.R2(client, os.environ.get('R2_BUCKET') or 'grilla'), profiles)
    for name, (tested, down) in done.items():
        print(f'✅ {name}: {tested} canales probados, {down} caídos en total')
    if not done:
        print('ℹ️  Ninguna cuenta con lista para probar (o el proveedor rechazó las pruebas)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
