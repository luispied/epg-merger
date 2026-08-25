#!/usr/bin/env python3
"""Genera playlist.m3u8 y my_epg.xml.gz cruzando la lista real de canales de
Xtream Codes con el EPG ya generado por merge_epgs.py (merged.xml.gz)."""
import gzip
import json
import os
import re
import unicodedata

from lxml import etree

from xtream_client import XtreamError, build_stream_url, get_live_streams

MERGED_EPG_PATH = 'merged.xml.gz'
CHANNEL_MAP_PATH = 'xtream_channel_map.json'
PLAYLIST_PATH = 'playlist.m3u8'
FILTERED_EPG_PATH = 'my_epg.xml.gz'

SUFFIXES = ('hd', 'fhd', 'uhd', '4k', 'sd', 'hevc')


def normalize_name(name):
    """Normaliza un nombre de canal para poder compararlo entre fuentes."""
    if not name:
        return ''
    name = unicodedata.normalize('NFKD', name)
    name = ''.join(c for c in name if not unicodedata.combining(c))
    name = name.lower()
    name = re.sub(r'\([^)]*\)', ' ', name)
    name = re.sub(r'[^a-z0-9]+', ' ', name)
    tokens = [t for t in name.split() if t not in SUFFIXES]
    return ' '.join(tokens)


def load_env_servers():
    username = os.environ.get('XTREAM_USERNAME')
    password = os.environ.get('XTREAM_PASSWORD')
    servers_raw = os.environ.get('XTREAM_SERVERS', '')
    servers = [s.strip() for s in servers_raw.split(',') if s.strip()]

    if not username or not password or not servers:
        return None, None, []

    return username, password, servers


def load_channel_map():
    try:
        with open(CHANNEL_MAP_PATH, 'r') as f:
            return json.load(f).get('overrides', {})
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def build_epg_index(epg_root):
    """channel_id -> (icon_src, {nombres normalizados}); nombre_normalizado -> channel_id"""
    channels_by_id = {}
    name_to_id = {}

    for channel in epg_root.findall('channel'):
        channel_id = channel.get('id')
        if not channel_id:
            continue

        icon_elem = channel.find('icon')
        icon_src = icon_elem.get('src') if icon_elem is not None else ''
        channels_by_id[channel_id] = icon_src

        for display_name in channel.findall('display-name'):
            normalized = normalize_name(display_name.text)
            if normalized and normalized not in name_to_id:
                name_to_id[normalized] = channel_id

    return channels_by_id, name_to_id


def match_channel(xtream_name, overrides, name_to_id):
    if xtream_name in overrides:
        return overrides[xtream_name]
    return name_to_id.get(normalize_name(xtream_name))


def generate():
    username, password, servers = load_env_servers()
    if not username:
        print("ℹ️  XTREAM_USERNAME/PASSWORD/SERVERS no configurados, se omite la playlist de Xtream")
        return

    try:
        active_server, live_streams = get_live_streams(servers, username, password)
    except XtreamError as e:
        print(f"❌ No se pudo obtener la lista de canales de Xtream: {e}")
        return

    with gzip.open(MERGED_EPG_PATH, 'rb') as f:
        epg_root = etree.fromstring(f.read())

    channels_by_id, name_to_id = build_epg_index(epg_root)
    overrides = load_channel_map()

    matched_ids = set()
    playlist_lines = ['#EXTM3U']
    unmatched = []

    for stream in live_streams:
        name = stream.get('name', '')
        stream_id = stream.get('stream_id')
        category = stream.get('category_name', 'General')
        container_ext = stream.get('container_extension', 'm3u8')

        channel_id = match_channel(name, overrides, name_to_id)
        if channel_id:
            matched_ids.add(channel_id)
            tvg_id = channel_id
            logo = channels_by_id.get(channel_id) or stream.get('stream_icon', '')
        else:
            unmatched.append(name)
            tvg_id = stream.get('epg_channel_id') or name
            logo = stream.get('stream_icon', '')

        stream_url = build_stream_url(active_server, username, password, stream_id, container_ext)

        playlist_lines.append(
            f'#EXTINF:-1 tvg-id="{tvg_id}" tvg-name="{name}" tvg-logo="{logo}" '
            f'group-title="{category}",{name}'
        )
        playlist_lines.append(stream_url)

    with open(PLAYLIST_PATH, 'w', encoding='utf-8') as f:
        f.write('\n'.join(playlist_lines) + '\n')

    filtered_root = etree.Element('tv', attrib=dict(epg_root.attrib))
    for channel in epg_root.findall('channel'):
        if channel.get('id') in matched_ids:
            filtered_root.append(channel)
    for programme in epg_root.findall('programme'):
        if programme.get('channel') in matched_ids:
            filtered_root.append(programme)

    body = etree.tostring(filtered_root, encoding='utf-8', xml_declaration=False, pretty_print=True)
    output = b'<?xml version="1.0" encoding="UTF-8" ?>\n' + body
    with gzip.open(FILTERED_EPG_PATH, 'wb') as f:
        f.write(output)

    print(f"\n📊 Canales de Xtream: {len(live_streams)}")
    print(f"   Con EPG matcheado: {len(matched_ids)}")
    print(f"   Sin EPG (revisar xtream_channel_map.json si aplica): {len(unmatched)}")
    if unmatched:
        preview = ', '.join(unmatched[:15])
        print(f"   Ejemplos sin match: {preview}")
    print(f"✅ {PLAYLIST_PATH} y {FILTERED_EPG_PATH} generados")


if __name__ == '__main__':
    generate()
