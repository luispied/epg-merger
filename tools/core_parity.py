#!/usr/bin/env python3
"""Casos de paridad para `@grilla/core` (el matcher en TypeScript, `core/`).

Exporta a un JSON la guía (canales), las reglas, las fuentes y una serie de canales de listas
con lo que el matcher de Python (`generate_playlist.match_stream`) elige para cada uno.
`node core/test/parity.ts <json>` corre el matcher de TypeScript sobre lo mismo y compara.

Casos:
- las listas del banco de prueba (`bench/lists/*.m3u`), con reglas genéricas y confiando en el
  `tvg-id` (como una lista M3U), y además solo por nombre;
- con `--luis`, los canales del `match_report` de Luis con sus reglas, su config por sección y
  categoría y sin confiar en el id del proveedor (como un perfil Xtream).

Con `--sample N` se recorta la guía a unos N canales (los elegidos en alguna corrida más
el resto al azar, con semilla fija) y se recalcula todo sobre la guía recortada: así sale un
fixture chico para el repo (`core/test/fixtures/parity.json`) que el CI prueba siempre.

Uso: `python tools/core_parity.py --merged merged.xml.gz [--luis match_report.json] --out x.json`.
"""
import argparse
import glob
import json
import os
import random
import sys

from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generate_playlist as gp  # noqa: E402
from channel_db import ChannelDb, _key, load_channel_db  # noqa: E402
from channel_names import RULES_PATH, flag_to_country_code, rules as default_rules, strip_display_prefix  # noqa: E402
from epg_index import EpgIndex  # noqa: E402
from merge_epgs import load_sources  # noqa: E402
from providers import parse_m3u  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BENCH_LISTS = os.path.join(ROOT, 'bench', 'lists', '*.m3u')


def guide_channels(root):
    out = []
    for channel in root.findall('channel'):
        if not channel.get('id'):
            continue
        icon = channel.find('icon')
        out.append({'id': channel.get('id'), 'source': channel.get('source'),
                    'names': [dn.text for dn in channel.findall('display-name') if dn.text],
                    'icon': icon.get('src') if icon is not None else ''})
    return out


def guide_root(channels):
    root = etree.Element('tv')
    for ch in channels:
        el = etree.SubElement(root, 'channel', id=ch['id'])
        if ch.get('source'):
            el.set('source', ch['source'])
        for name in ch['names']:
            etree.SubElement(el, 'display-name').text = name
        if ch.get('icon'):
            etree.SubElement(el, 'icon', src=ch['icon'])
    return root


def bench_suites():
    rules = gp.load_provider_rules(os.path.join(ROOT, '__sin_reglas__.json'))
    cases = []
    for path in sorted(glob.glob(BENCH_LISTS)):
        with open(path, encoding='utf-8') as f:
            for ch in parse_m3u(f.read()):
                cases.append({'name': ch['name'], 'tvg_id': ch['epg_channel_id'], 'category': ch['category'],
                              'category_country': None, 'epg_config': {}})
    name_only = [{**c, 'tvg_id': None} for c in cases]
    return [{'name': 'bench', 'provider_rules': rules, 'trust_list_ids': True, 'cases': cases},
            {'name': 'bench (solo nombre)', 'provider_rules': rules, 'trust_list_ids': True, 'cases': name_only}]


def luis_suite(report_path):
    rules = gp.load_provider_rules(os.path.join(ROOT, gp.PROVIDER_RULES_PATH))
    gp.set_provider_rules(rules)
    _, section_rules, section_epg, _ = gp.load_sections_config(os.path.join(ROOT, gp.SECTIONS_CONFIG_PATH))
    with open(report_path, encoding='utf-8') as f:
        report = json.load(f)['channels']
    cases = []
    for ch in report:
        if gp.is_divider_category(ch['category']):
            continue
        section = gp.classify_section(ch['category'], section_rules)
        cases.append({'name': ch['xtream_name'], 'tvg_id': ch.get('provider_epg_id'), 'category': ch['category'],
                      'category_country': flag_to_country_code(ch['category']),
                      'epg_config': gp.epg_config_for(section, ch['category'], section_epg)})
    return {'name': 'luis', 'provider_rules': rules, 'trust_list_ids': False, 'cases': cases}


def run(suites, channels, sources, db):
    """Completa `expected` en cada caso con lo que elige Python sobre esta guía."""
    index = EpgIndex(guide_root(channels), sources=sources)
    gp.set_channel_db(db)
    for suite in suites:
        gp.set_provider_rules(suite['provider_rules'])
        index.preferred_feed = gp._rules.preferred_feed
        for case in suite['cases']:
            _, cid, reason, score, _ = gp.match_stream(
                case['name'], case['tvg_id'], index, {}, case['epg_config'], case['category_country'],
                trust_list_ids=suite['trust_list_ids'])
            case['expected'] = {'channel_id': cid, 'reason': reason, 'score': score}
    gp.set_channel_db(None)


def db_subset(db_raw, suites, rules):
    """Solo las entradas del diccionario que puede consultar algún caso (por id o por nombre):
    las listas por nombre quedan completas, así da lo mismo que con el diccionario entero."""
    full = ChannelDb(db_raw, rules)
    keep = set()
    for suite in suites:
        for case in suite['cases']:
            name, _ = strip_display_prefix(case['name'], rules)
            if case['tvg_id']:
                entry = full.by_id.get(case['tvg_id'].split('@')[0].strip().lower())
                if entry:
                    keep.add(entry['id'])
            keep.update(e['id'] for e in full.by_name.get(_key(name, rules), []))
    return [ch for ch in db_raw if isinstance(ch, dict) and ch.get('id') in keep]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--merged', default=gp.MERGED_EPG_PATH)
    ap.add_argument('--luis', help='match_report de Luis (con provider_epg_id)')
    ap.add_argument('--channel-db', default=os.path.join(ROOT, 'iptv_channels.json'),
                    help="diccionario de iptv-org; '' para no usarlo")
    ap.add_argument('--sample', type=int, help='recortar la guía a unos N canales')
    ap.add_argument('--out', required=True)
    args = ap.parse_args(argv)

    channels = guide_channels(gp.load_epg_channels(args.merged))
    sources = {s['id']: {'country': s.get('country'), 'priority': s.get('priority', 0)}
               for s in load_sources(os.path.join(ROOT, 'epg_urls.json'),
                                     os.path.join(ROOT, 'epg_sources_catalog.json'))}
    rules = default_rules()
    db_raw = None
    if args.channel_db and os.path.exists(args.channel_db):
        with open(args.channel_db, encoding='utf-8') as f:
            db_raw = json.load(f)
    suites = bench_suites() + ([luis_suite(args.luis)] if args.luis else [])
    if db_raw is not None:
        db_raw = db_subset(db_raw, suites, rules)
    db = load_channel_db('', rules) if db_raw is None else ChannelDb(db_raw, rules)

    run(suites, channels, sources, db)
    if args.sample and args.sample < len(channels):
        chosen = {c['expected']['channel_id'] for s in suites for c in s['cases']} - {None}
        rest = [ch for ch in channels if ch['id'] not in chosen]
        keep = chosen | {ch['id'] for ch in random.Random(7).sample(rest, max(0, args.sample - len(chosen)))}
        channels = [ch for ch in channels if ch['id'] in keep]
        run(suites, channels, sources, db)

    with open(RULES_PATH, encoding='utf-8') as f:
        matching_rules = json.load(f)
    out = {'matching_rules': matching_rules, 'sources': sources, 'channels': channels,
           'channel_db': db_raw, 'suites': [
               {'name': s['name'], 'trust_list_ids': s['trust_list_ids'],
                'min_assign_score': gp._Rules(s['provider_rules']).min_assign_score,
                'preferred_feed': gp._Rules(s['provider_rules']).preferred_feed,
                'cases': s['cases']} for s in suites]}
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    total = sum(len(s['cases']) for s in suites)
    print(f"{len(channels)} canales de guía, {total} casos en {len(suites)} grupos → {args.out}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
