#!/usr/bin/env python3
"""Diccionario de canales de iptv-org (https://github.com/iptv-org/database, dominio público).

31 mil canales con su nombre, nombres alternativos y país: "Das Erste" también se llama "ARD",
"El Trece" es "Canal 13", "13C" es "Canal 13 Cable". El matcher lo usa como último recurso,
cuando un canal no encontró guía por su nombre: prueba con los otros nombres del mismo canal.

El workflow lo baja en cada corrida (`CHANNEL_DB_PATH`); si no está, todo sigue igual sin él.
"""
import collections
import json

from channel_names import parse_channel_name

CHANNEL_DB_PATH = 'iptv_channels.json'
CHANNEL_DB_URL = 'https://iptv-org.github.io/api/channels.json'
MAX_ENTRIES_BY_NAME = 3  # un nombre compartido por más canales que esto no sirve para decidir


def _key(name, r=None):
    return ''.join(parse_channel_name(name or '', r).core)


class ChannelDb:
    def __init__(self, channels, r=None):
        self.rules = r
        self.by_id = {}
        self.by_name = collections.defaultdict(list)
        for ch in channels:
            if not isinstance(ch, dict) or not ch.get('id') or ch.get('closed'):
                continue
            entry = {
                'id': ch['id'],
                'names': [n for n in [ch.get('name')] + list(ch.get('alt_names') or []) if n],
                'country': (ch.get('country') or '').lower() or None,
            }
            self.by_id[entry['id'].lower()] = entry
            for name in entry['names']:
                key = _key(name, r)
                if key and entry not in self.by_name[key]:
                    self.by_name[key].append(entry)

    def __len__(self):
        return len(self.by_id)

    def entries_for(self, name, tvg_id=None, country=None):
        """Canales del diccionario que corresponden a este: por el id de la lista (el tvg-id de
        iptv-org, sin "@SD") o por nombre exacto. Por nombre, si hay país se filtra por él, y un
        nombre demasiado común (muchos canales) no se usa."""
        if tvg_id:
            entry = self.by_id.get(tvg_id.split('@')[0].strip().lower())
            if entry:
                return [entry]
        entries = self.by_name.get(_key(name, self.rules), [])
        if country:
            entries = [e for e in entries if e['country'] == country] or []
        return entries if len(entries) <= MAX_ENTRIES_BY_NAME else []

    def aliases(self, name, tvg_id=None, country=None):
        """[(otro_nombre, país)] del mismo canal, sin el propio nombre ni los que son un
        recorte de él ("RTL 102.5" no es un alias útil de "RTL 102.5 Traffic": es otro canal)."""
        own = set(parse_channel_name(name or '', self.rules).core)
        own_key = _key(name, self.rules)
        out = []
        for entry in self.entries_for(name, tvg_id, country):
            for alias in entry['names']:
                parsed = parse_channel_name(alias, self.rules)
                key = ''.join(parsed.core)
                if not key or key == own_key or (set(parsed.core) < own and own):
                    continue
                if (alias, entry['country']) not in out:
                    out.append((alias, entry['country']))
        return out


def load_channel_db(path=CHANNEL_DB_PATH, r=None):
    """ChannelDb del JSON de la API de iptv-org, o None si no está o no se puede leer."""
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, list):
        return None
    return ChannelDb(data, r)
