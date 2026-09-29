#!/usr/bin/env python3
"""Aprende de los overrides qué fuente de EPG conviene preferir en cada categoría.

Los overrides de `xtream_channel_map.json` son correcciones a mano; muchas repiten un mismo
criterio ("en ESPN elijo siempre la guía de programadorx-cl"). Para cada categoría con
overrides, se prueba preferir cada fuente que aparece en ellos y se mide, con el matcher real:

- **aciertos:** overrides que el matcher pasaría a resolver solo (ya no harían falta);
- **roturas:** overrides que hoy resuelve solo y dejaría de resolver;
- **cambios:** canales SIN override de esa categoría a los que les cambiaría la guía (no se
  sabe si para mejor: se listan para revisarlos).

Una sugerencia es segura si tiene aciertos, cero roturas y cero cambios. Con `--apply` se
escriben las seguras en `playlist_sections.json` → `category_epg`.

Uso: `python tools/learn_preferences.py --merged merged.xml.gz --report match_report-luis.json [--apply]`.
"""
import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import generate_playlist as gp  # noqa: E402
from channel_names import flag_to_country_code  # noqa: E402
from epg_index import EpgIndex  # noqa: E402
from match_benchmark import Judge  # noqa: E402
from merge_epgs import load_sources  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIN_OVERRIDES = 2


def auto_pick(ch, index, cfg):
    _, cid, _, _, _ = gp.match_stream(ch['xtream_name'], ch.get('provider_epg_id'), index, {}, cfg,
                                      flag_to_country_code(ch['category']), trust_list_ids=False)
    return cid


def learn(report, channel_map, index, sections, judge):
    _, section_rules, section_epg, _ = sections
    overrides = channel_map.get('overrides') or {}
    hidden_cats = {k for k, v in (channel_map.get('hidden_categories') or {}).items() if v}
    by_cat = collections.defaultdict(list)
    for ch in report:
        if not gp.is_divider_category(ch['category']):
            by_cat[ch['category']].append(ch)

    def ok(cid, want):
        return cid is not None and (cid == want or judge.same(cid, want))

    suggestions = []
    for cat, channels in by_cat.items():
        # Solo los overrides a un canal: uno en null ("sin EPG a propósito") además marca el
        # canal como revisado, y no hay que tratarlo como algo que el matcher pueda reemplazar.
        wanted = {ch['xtream_name']: overrides[ch['xtream_name']] for ch in channels
                  if overrides.get(ch['xtream_name']) and overrides[ch['xtream_name']] in index}
        if len(wanted) < MIN_OVERRIDES:
            continue
        section = gp.classify_section(cat, section_rules)
        base_cfg = gp.epg_config_for(section, cat, section_epg)
        base = {ch['xtream_name']: auto_pick(ch, index, base_cfg) for ch in channels}
        sources = collections.Counter(index.source.get(t) for t in wanted.values() if index.source.get(t))
        for source, _ in sources.most_common(3):
            if source in (base_cfg.get('prefer_sources') or [])[:1]:
                continue  # ya es la preferida
            cfg = dict(base_cfg)
            cfg['prefer_sources'] = [source] + [s for s in base_cfg.get('prefer_sources') or [] if s != source]
            gains, losses, changes = [], [], []
            for ch in channels:
                name = ch['xtream_name']
                new = auto_pick(ch, index, cfg)
                if name in wanted:
                    was, now = ok(base[name], wanted[name]), ok(new, wanted[name])
                    if now and not was:
                        gains.append(name)
                    elif was and not now:
                        losses.append(name)
                elif name not in overrides and new != base[name] and cat not in hidden_cats:
                    changes.append({'channel': name, 'before': index.display_name.get(base[name]),
                                    'after': index.display_name.get(new)})
            if gains:
                suggestions.append({'category': cat, 'source': source, 'gains': gains, 'losses': losses,
                                    'changes': changes, 'safe': not losses and not changes})
    suggestions.sort(key=lambda s: (not s['safe'], -len(s['gains'])))
    return suggestions


def apply(suggestions, path):
    """Escribe las sugerencias seguras en `category_epg`, tocando solo ese bloque del archivo
    (el resto de playlist_sections.json está formateado a mano)."""
    with open(path, encoding='utf-8') as f:
        text = f.read()
    config = json.loads(text)
    cat_epg = dict(config.get('category_epg') or {})
    done = set()
    for s in suggestions:
        if not s['safe'] or s['category'] in done:
            continue
        done.add(s['category'])
        cfg = dict(cat_epg.get(s['category']) or {})
        cfg['prefer_sources'] = [s['source']] + [x for x in cfg.get('prefer_sources', []) if x != s['source']]
        cat_epg[s['category']] = cfg
    if not done:
        return []
    block = '  "category_epg": {\n' + ',\n'.join(
        f'    {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}' for k, v in cat_epg.items()
    ) + '\n  },\n'
    start = text.find('  "category_epg": {')
    if start >= 0:
        end = text.index('\n  },\n', start) + len('\n  },\n')
        text = text[:start] + block + text[end:]
    else:
        at = text.index('  "rules": [')
        text = text[:at] + block + text[at:]
    json.loads(text)  # no escribir nunca un JSON roto
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return sorted(done)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--merged', default=gp.MERGED_EPG_PATH)
    ap.add_argument('--report', required=True, help='match_report del perfil (con provider_epg_id)')
    ap.add_argument('--map', default=os.path.join(ROOT, gp.CHANNEL_MAP_PATH))
    ap.add_argument('--sections', default=os.path.join(ROOT, gp.SECTIONS_CONFIG_PATH))
    ap.add_argument('--apply', action='store_true', help='escribir las sugerencias seguras')
    args = ap.parse_args(argv)

    gp.set_provider_rules(gp.load_provider_rules(os.path.join(ROOT, gp.PROVIDER_RULES_PATH)))
    root = gp.load_epg_channels(args.merged)
    index = EpgIndex(root, sources={s['id']: s for s in load_sources(os.path.join(ROOT, 'epg_urls.json'),
                                                                     os.path.join(ROOT, 'epg_sources_catalog.json'))})
    index.preferred_feed = gp._rules.preferred_feed
    with open(args.report, encoding='utf-8') as f:
        report = json.load(f)['channels']
    with open(args.map, encoding='utf-8') as f:
        channel_map = json.load(f)
    suggestions = learn(report, channel_map, index, gp.load_sections_config(args.sections), Judge(index))
    for s in suggestions:
        mark = '✅' if s['safe'] else '⚠️ '
        print(f"{mark} {s['category']}: preferir {s['source']} → +{len(s['gains'])} override(s) resueltos, "
              f"{len(s['losses'])} roto(s), {len(s['changes'])} canal(es) sin override cambian")
        for c in s['changes'][:5]:
            print(f"      {c['channel']}: {c['before']} → {c['after']}")
    if args.apply:
        applied = apply(suggestions, args.sections)
        print(f"\nAplicadas en {args.sections}: {', '.join(applied) or 'ninguna'}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
