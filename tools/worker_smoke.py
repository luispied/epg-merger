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
import re
import sys
import urllib.parse

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from profiles import load_profiles  # noqa: E402

TIMEOUT = 60


def host(url):
    return urllib.parse.urlsplit(url).netloc or '?'


STREAM_ID_RE = re.compile(r'/(\d+)(?:\.([A-Za-z0-9]{1,6}))?(?:[?#].*)?$')


def m3u_shape(servers, creds):
    """Cómo es la lista M3U que da el proveedor (get.php), la que la web le pide subir a la
    persona. Solo la forma: cantidades, nombres de atributos y URLs con usuario y contraseña
    tapados."""
    print('\n0. Forma de la lista M3U del proveedor (get.php, directo desde GitHub)')
    u, p = creds['username'], creds['password']

    def mask(text):
        for secret, label in ((p, '<clave>'), (u, '<usuario>'), (urllib.parse.quote(p), '<clave>'),
                              (urllib.parse.quote(u), '<usuario>')):
            if secret:
                text = text.replace(secret, label)
        return text

    for server in servers:
        try:
            r = requests.get(f'{server}/get.php', timeout=60,
                             params={**creds, 'type': 'm3u_plus', 'output': 'ts'})
        except requests.RequestException as e:
            print(f'   {host(server)}: {type(e).__name__}')
            continue
        text = r.text
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        extinf = [line for line in lines if line.startswith('#EXTINF')]
        urls = [line for line in lines if not line.startswith('#')]
        matching = sum(1 for x in urls if STREAM_ID_RE.search(x))
        print(f"   {host(server)}: HTTP {r.status_code}, {r.headers.get('content-type', '?')}, "
              f"{len(r.content) // 1024} KB, {len(extinf)} #EXTINF, {len(urls)} URLs, {matching} con stream_id")
        print(f'   primera línea: {mask(lines[0][:80]) if lines else "(vacío)"}')
        if extinf:
            attrs = re.findall(r'([\w-]+)="', extinf[0])
            print(f'   atributos del primer #EXTINF: {attrs}; empieza: {extinf[0][:14]!r}')
        for x in urls[:3]:
            print(f'   URL: {mask(x)[:120]}')
        others = [x for x in urls if not STREAM_ID_RE.search(x)]
        for x in others[:3]:
            print(f'   URL sin stream_id: {mask(x)[:120]}')
        if r.ok and extinf:
            return


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
    m3u_shape(servers, creds)
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

    # Algunos proveedores filtran por User-Agent: se prueba con varios en el primer servidor
    # que responde directo desde GitHub.
    print('\n1b. Mismo pedido a través del Worker con distintos User-Agent (primer servidor)')
    for ua in ('Grilla/1.0', 'python-requests/2.32.3', 'okhttp/4.12.0', 'VLC/3.0.21 LibVLC/3.0.21',
               'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'):
        r = requests.post(f'{worker}/api/provider/list', timeout=TIMEOUT,
                          json={'type': 'xtream', 'servers': servers[:1], 'userAgent': ua, **creds})
        detail = f"{len(r.json()['channels'])} canales" if r.ok else r.json().get('error', '')[:140]
        print(f"   {'✅' if r.ok else '❌'} {ua[:40]}: {detail}")

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
