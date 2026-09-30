#!/usr/bin/env python3
"""Compara la playlist y la guía de Grilla web con las de la corrida de GitHub.

Para cada perfil de XTREAM_PROFILES con `gist_id`:
- **GitHub:** la playlist publicada en su gist secreto (la de la última corrida diaria).
- **Grilla web:** las configuraciones enlazadas a esa cuenta en R2 (`links/<huella>.json`), con
  su lista (`list/<cfgId>.json`); la playlist se arma con el mismo código del Worker
  (`tools/web_playlist.ts`) y la guía es `epg/<cfgId>.xml.gz`.

Los canales se emparejan por el id de stream del proveedor. Informa canales que están en una
sola, EPG distinto (tvg-id), nombre distinto, categoría distinta, el orden de las categorías, y
los EPG de la playlist web que su guía no trae. Nunca muestra URLs ni credenciales.

Uso: `python tools/compare_web.py` (con GIST_TOKEN, XTREAM_PROFILES y las variables de R2).
"""
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile

import requests
from lxml import etree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'tools'))

from profiles import load_profiles  # noqa: E402
from push_lists import R2, link_hash  # noqa: E402

GIST_API = 'https://api.github.com/gists'
SHOW = 15  # ejemplos por diferencia
_ATTR_RE = re.compile(r'([\w-]+)="([^"]*)"')


def parse_playlist(text):
    """[{id, tvg_id, name, group}] en orden, emparejables por id de stream (sin URLs)."""
    entries, extinf = [], None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('#EXTINF'):
            extinf = line
        elif line and not line.startswith('#') and extinf:
            attrs = dict(_ATTR_RE.findall(extinf.split(',', 1)[0]))
            stream = line.split('?')[0].rstrip('/').rsplit('/', 1)[-1]
            entries.append({
                'id': stream.rsplit('.', 1)[0],
                'tvg_id': attrs.get('tvg-id', ''),
                'name': extinf.split(',', 1)[1] if ',' in extinf else '',
                'group': attrs.get('group-title', ''),
            })
            extinf = None
    return entries


def group_order(entries):
    out = []
    for e in entries:
        if not out or out[-1] != e['group']:
            if e['group'] not in out:
                out.append(e['group'])
    return out


def compare(github, web):
    gh = {e['id']: e for e in github}
    wb = {e['id']: e for e in web}
    both = [i for i in gh if i in wb]
    diff = lambda field: [(gh[i]['name'], gh[i][field], wb[i][field]) for i in both if gh[i][field] != wb[i][field]]  # noqa: E731
    gh_order = [g for g in group_order(github) if g in set(group_order(web))]
    web_order = [g for g in group_order(web) if g in set(gh_order)]
    first = next((k for k, (a, b) in enumerate(zip(gh_order, web_order)) if a != b), None)
    return {
        'github': len(github), 'web': len(web), 'both': len(both),
        'only_github': [gh[i]['name'] for i in gh if i not in wb],
        'only_web': [wb[i]['name'] for i in wb if i not in gh],
        'epg': diff('tvg_id'), 'name': diff('name'), 'group': diff('group'),
        'groups_only_github': [g for g in group_order(github) if g not in set(group_order(web))],
        'groups_only_web': [g for g in group_order(web) if g not in set(group_order(github))],
        'order_first_diff': None if first is None else (first, gh_order[first], web_order[first]),
    }


def guide_ids(xml_gz):
    """(ids de <channel>, ids con al menos un <programme>) de una guía."""
    channels, with_programmes = set(), set()
    for _, el in etree.iterparse(gzip.open(xml_gz), events=('end',), tag=('channel', 'programme')):
        if el.tag == 'channel':
            channels.add(el.get('id'))
        else:
            with_programmes.add(el.get('channel'))
        el.clear()
    return channels, with_programmes


def report(profile, cfg_id, r, missing_guide):
    lines = [f"## {profile} · configuración web `{cfg_id[:6]}…`", '',
             f"- Canales: GitHub **{r['github']}**, web **{r['web']}**, en las dos **{r['both']}**",
             f"- EPG distinto: **{len(r['epg'])}** · nombre distinto: **{len(r['name'])}** · categoría distinta: **{len(r['group'])}**",
             f"- Solo en GitHub: **{len(r['only_github'])}** · solo en la web: **{len(r['only_web'])}**"
             ' (los eventos del día cambian entre la corrida diaria y la lista de la web)']
    o = r['order_first_diff']
    lines.append('- Orden de categorías: ' + ('igual ✅' if o is None else
                 f"distinto desde la posición {o[0] + 1}: GitHub «{o[1]}», web «{o[2]}»"))
    if missing_guide is not None:
        lines.append(f"- EPG de la playlist web que su guía no trae: **{len(missing_guide)}**")
    ok = not (r['epg'] or r['name'] or r['group'] or o or missing_guide)
    lines += ['', '**Iguales ✅**' if ok else '**Hay diferencias** (ejemplos abajo)', '']

    def section(title, rows, fmt):
        if rows:
            lines.extend([f'<details><summary>{title} ({len(rows)})</summary>', ''] +
                         [f'- {fmt(x)}' for x in rows[:SHOW]] +
                         ([f'- … y {len(rows) - SHOW} más'] if len(rows) > SHOW else []) + ['', '</details>'])
    section('EPG distinto', r['epg'], lambda x: f'{x[0]}: GitHub `{x[1]}` → web `{x[2]}`')
    section('Nombre distinto', r['name'], lambda x: f'{x[1]} → {x[2]}')
    section('Categoría distinta', r['group'], lambda x: f'{x[0]}: {x[1]} → {x[2]}')
    section('Categorías solo en GitHub', r['groups_only_github'], str)
    section('Categorías solo en la web', r['groups_only_web'], str)
    section('Canales solo en GitHub', r['only_github'], str)
    section('Canales solo en la web', r['only_web'], str)
    section('EPG sin guía en la web', sorted(missing_guide or []), lambda x: f'`{x}`')
    return '\n'.join(lines) + '\n'


def gist_playlist(gist_id, token):
    """La playlist del gist. El token va solo a api.github.com; el contenido truncado se baja de
    su raw_url (secreto pero sin autenticación), sin token."""
    res = requests.get(f'{GIST_API}/{gist_id}', timeout=60,
                       headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
    res.raise_for_status()
    f = next(iter(res.json()['files'].values()))
    if f.get('truncated'):
        raw = requests.get(f['raw_url'], timeout=120)
        raw.raise_for_status()
        return raw.text
    return f['content']


def web_playlist(cfg, channels, tmp):
    cfg_path, list_path = os.path.join(tmp, 'cfg.json'), os.path.join(tmp, 'list.json')
    with open(cfg_path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f)
    with open(list_path, 'w', encoding='utf-8') as f:
        json.dump({'channels': channels}, f)
    return subprocess.run(['node', os.path.join(ROOT, 'tools', 'web_playlist.ts'), cfg_path, list_path],
                          check=True, capture_output=True, text=True).stdout


def main():
    token = os.environ.get('GIST_TOKEN')
    needed = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if not token or not all(os.environ.get(k) for k in needed):
        print('❌ Faltan GIST_TOKEN o las credenciales de R2')
        return 1
    import boto3
    client = boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')
    r2 = R2(client, os.environ.get('R2_BUCKET') or 'grilla')
    out = ['# Grilla web vs. GitHub', '']
    for profile in load_profiles():
        if not profile.get('gist_id') or profile.get('type', 'xtream') != 'xtream':
            continue
        link = r2.get(f"links/{link_hash(profile['username'], profile['password'])}.json")
        cfg_ids = json.loads(link[0]).get('cfgIds', []) if link else []
        if not cfg_ids:
            out.append(f"## {profile['name']}\n\nSin configuración de Grilla web enlazada a esta cuenta.\n")
            continue
        github = parse_playlist(gist_playlist(profile['gist_id'], token))
        for cfg_id in cfg_ids:
            cfg, lst = r2.get(f'cfg/{cfg_id}.json'), r2.get(f'list/{cfg_id}.json')
            if not cfg or not lst:
                out.append(f"## {profile['name']} · `{cfg_id[:6]}…`\n\nFalta la configuración o su lista en R2.\n")
                continue
            with tempfile.TemporaryDirectory() as tmp:
                web = parse_playlist(web_playlist(json.loads(cfg[0]), json.loads(lst[0])['channels'], tmp))
                missing = None
                epg = r2.get(f'epg/{cfg_id}.xml.gz')
                if epg:
                    path = os.path.join(tmp, 'epg.xml.gz')
                    with open(path, 'wb') as f:
                        f.write(epg[0])
                    ids, _ = guide_ids(path)
                    names = {e['name'] for e in web}
                    missing = {e['tvg_id'] for e in web if e['tvg_id'] not in ids and e['tvg_id'] not in names}
            out.append(report(profile['name'], cfg_id, compare(github, web), missing))
    text = '\n'.join(out)
    print(text)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
