#!/usr/bin/env python3
"""Prueba real del Worker de Grilla con un perfil de verdad (el de XTREAM_PROFILES).

Hace lo que va a hacer Grilla web y un reproductor:
1. baja la lista del proveedor a través del Worker, probando cada servidor del balanceador
   por separado (así se ve si Cloudflare llega a cada uno);
2. crea una configuración de prueba, pide el link cifrado, baja la playlist y sigue el
   redirect de un canal (/s/…) hasta el servidor sano;
3. borra la configuración de prueba.

Solo imprime cantidades y nombres de servidor: nunca usuario, contraseña, token ni links.
Uso (workflow worker-smoke.yml): `python tools/worker_smoke.py --worker https://… [--profile luis]`.
"""
import argparse
import os
import sys
import urllib.parse

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from profiles import load_profiles  # noqa: E402

TIMEOUT = 60


def host(url):
    return urllib.parse.urlsplit(url).netloc or '?'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--worker', required=True)
    ap.add_argument('--profile', default='')
    args = ap.parse_args(argv)
    worker = args.worker.rstrip('/')

    profiles = [p for p in load_profiles() if p.get('type', 'xtream') == 'xtream']
    profile = next((p for p in profiles if p['name'] == args.profile), profiles[0] if profiles else None)
    if not profile:
        print('❌ No hay perfiles Xtream configurados')
        return 1
    creds = {'username': profile['username'], 'password': profile['password']}
    servers = profile['servers']
    print(f"Perfil '{profile['name']}': {len(servers)} servidor(es) en el balanceador")

    ok = True
    print('\n1. Lista del proveedor a través del Worker, servidor por servidor')
    for i, server in enumerate(servers, 1):
        # Directo desde GitHub (lo que usa la corrida de hoy), para comparar con el Worker.
        try:
            d = requests.get(f'{server}/player_api.php', params={**creds, 'action': 'get_live_categories'}, timeout=30)
            is_json = d.headers.get('content-type', '').startswith('application/json') or d.text[:1] in '[{'
            print(f"   directo  {i}. {host(server)}: HTTP {d.status_code}{'' if is_json else ' (no es JSON)'}"
                  f" server={d.headers.get('Server', '?')}")
        except requests.RequestException as e:
            print(f'   directo  {i}. {host(server)}: {type(e).__name__}')
        r = requests.post(f'{worker}/api/provider/list', timeout=TIMEOUT,
                          json={'type': 'xtream', 'servers': [server], **creds})
        if r.ok:
            chs = r.json()['channels']
            cats = len({c['category'] for c in chs})
            print(f'   ✅ {i}. {host(server)}: {len(chs)} canales, {cats} categorías')
        else:
            ok = False
            msg = r.json().get('error', r.text[:200]) if 'json' in r.headers.get('content-type', '') else r.text[:200]
            print(f'   ❌ {i}. {host(server)}: HTTP {r.status_code} — {msg}')

    print('\n2. Configuración de prueba → link → playlist → redirect')
    r = requests.post(f'{worker}/api/cfg', timeout=TIMEOUT,
                      json={'provider': {'type': 'xtream', 'servers': servers}, 'channels': {}})
    if not r.ok:
        print(f'   ❌ crear configuración: HTTP {r.status_code} {r.text[:200]}')
        return 1
    cfg = r.json()
    auth = {'Authorization': f"Bearer {cfg['editKey']}"}
    try:
        r = requests.post(f"{worker}/api/cfg/{cfg['cfgId']}/token", headers=auth, json=creds, timeout=TIMEOUT)
        r.raise_for_status()
        links = r.json()
        r = requests.get(links['playlistUrl'], timeout=TIMEOUT)
        if not r.ok:
            print(f'   ❌ playlist: HTTP {r.status_code} {r.text[:200]}')
            return 1
        lines = r.text.splitlines()
        entries = sum(1 for line in lines if line.startswith('#EXTINF'))
        print(f"   ✅ playlist: {entries} canales ({len(r.content) // 1024} KB, {r.elapsed.total_seconds():.1f} s)")
        stream = next((line for line in lines if line.startswith(f'{worker}/s/')), None)
        if stream:
            r = requests.get(stream, allow_redirects=False, timeout=TIMEOUT)
            if r.status_code == 302:
                target = r.headers.get('Location', '')
                idx = next((i for i, s in enumerate(servers, 1) if host(s) == host(target)), '?')
                print(f'   ✅ redirect de un canal → servidor {idx} ({host(target)}) en {r.elapsed.total_seconds():.1f} s')
            else:
                ok = False
                print(f'   ❌ redirect: HTTP {r.status_code}')
        r = requests.get(links['playlistUrl'], timeout=TIMEOUT)
        print(f"   ✅ segunda vez (lista guardada): {r.elapsed.total_seconds():.1f} s")
    finally:
        requests.delete(f"{worker}/api/cfg/{cfg['cfgId']}", headers=auth, timeout=TIMEOUT)
        print('   🧹 configuración de prueba borrada')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
