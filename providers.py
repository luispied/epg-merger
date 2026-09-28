#!/usr/bin/env python3
"""Proveedores de canales: de dónde sale la lista que se cruza con el EPG.

Cada proveedor devuelve la misma forma, así el resto del pipeline no depende de cuál es:

    [{'name', 'category', 'url', 'icon', 'epg_channel_id'}, ...]

en el orden en que el proveedor los lista (las categorías aparecen en ese mismo orden).

- **xtream**: API Xtream Codes (`player_api.php`), con failover entre servidores.
- **m3u**: una lista M3U/M3U8 por URL o archivo local; `group-title` es la categoría,
  `tvg-id` el id de EPG que sugiere la lista y `tvg-logo` el logo.
"""
import os
import re

import requests

from xtream_client import XtreamError, build_stream_url, get_live_categories, get_live_streams


class ProviderError(Exception):
    pass


def _channel(name, category, url, icon='', epg_channel_id=None):
    return {
        'name': name or '',
        'category': category or 'General',
        'url': url,
        'icon': icon or '',
        'epg_channel_id': epg_channel_id or None,
    }


class XtreamProvider:
    kind = 'xtream'

    def __init__(self, profile, get_streams=None, get_categories=None):
        self.profile = profile
        # Inyectables (los tests reemplazan las llamadas de red).
        self._get_streams = get_streams or get_live_streams
        self._get_categories = get_categories or get_live_categories

    def load(self):
        p = self.profile
        username, password = p['username'], p['password']
        try:
            server, streams = self._get_streams(p['servers'], username, password)
        except XtreamError as e:
            raise ProviderError(f"No se pudo obtener la lista de canales de Xtream: {e}") from e
        categories = self._get_categories(server, username, password)
        print(f"📂 Categorías encontradas: {len(categories)}")
        return [
            _channel(
                s.get('name', ''),
                categories.get(str(s.get('category_id')), 'General'),
                build_stream_url(server, username, password, s.get('stream_id'),
                                 s.get('container_extension', 'm3u8')),
                s.get('stream_icon', ''),
                s.get('epg_channel_id'),
            )
            for s in streams
        ]


# #EXTINF:-1 tvg-id="x" tvg-logo="y" group-title="z",Nombre del canal
_EXTINF_RE = re.compile(r'^#EXTINF:\s*-?\d+(?P<attrs>(?:\s+[\w-]+="[^"]*")*)[^,]*,(?P<name>.*)$')
_ATTR_RE = re.compile(r'([\w-]+)="([^"]*)"')


def parse_m3u(text):
    """Canales de un M3U extendido. Soporta `#EXTGRP:` como alternativa a `group-title` y
    ignora las demás directivas (#EXTVLCOPT, #KODIPROP…)."""
    channels = []
    pending = None
    group = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith('#EXTINF'):
            m = _EXTINF_RE.match(line)
            if not m:
                pending = None
                continue
            attrs = dict(_ATTR_RE.findall(m.group('attrs') or ''))
            pending = {
                'name': m.group('name').strip() or attrs.get('tvg-name', ''),
                'category': attrs.get('group-title'),
                'icon': attrs.get('tvg-logo', ''),
                'epg_channel_id': attrs.get('tvg-id'),
            }
            group = None
        elif line.startswith('#EXTGRP:'):
            group = line.split(':', 1)[1].strip()
        elif line.startswith('#'):
            continue
        elif pending is not None:
            channels.append(_channel(pending['name'], pending['category'] or group, line,
                                     pending['icon'], pending['epg_channel_id']))
            pending = None
            group = None
    return channels


class M3UProvider:
    kind = 'm3u'

    def __init__(self, profile, fetch=None):
        self.profile = profile
        self._fetch = fetch or _fetch_text

    def load(self):
        try:
            text = self._fetch(self.profile['url'])
        except Exception as e:  # noqa: BLE001 — red o archivo: cualquier falla corta el perfil
            raise ProviderError(f"No se pudo leer la lista M3U: {e}") from e
        channels = parse_m3u(text)
        if not channels:
            raise ProviderError("La lista M3U no tiene canales (¿es un #EXTM3U válido?)")
        categories = list(dict.fromkeys(c['category'] for c in channels))
        print(f"✅ Lista M3U: {len(channels)} canales")
        print(f"📂 Categorías encontradas: {len(categories)}")
        return channels


def _fetch_text(location, timeout=30):
    if re.match(r'^https?://', location):
        response = requests.get(location, timeout=timeout)
        response.raise_for_status()
        return response.content.decode('utf-8', errors='replace')
    with open(os.path.expanduser(location), encoding='utf-8', errors='replace') as f:
        return f.read()


def provider_for(profile, **kwargs):
    kind = profile.get('type', 'xtream')
    if kind == 'm3u':
        return M3UProvider(profile, **kwargs)
    return XtreamProvider(profile, **kwargs)
