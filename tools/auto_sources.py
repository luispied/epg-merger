#!/usr/bin/env python3
"""Fuentes de guía automáticas: se activan solas cuando alguien las necesita y se retiran
cuando nadie las usa. Así Grilla cubre cualquier país del catálogo sin bajar las 548 fuentes
todos los días.

Cada corrida diaria, después de generate_playlist.py:

1. **Demanda.** Los canales visibles sin guía de todas las listas: los perfiles de la corrida
   (out/<perfil>/match_report.json) y cada configuración de Grilla web (cfg/<cfgId>.json con su
   lista guardada list/<cfgId>.json, en R2). De ahí salen los países que faltan.
2. **Candidatas.** Fuentes `fresh` del catálogo de esos países que no están en epg_urls.json (lo
   que se decidió a mano, activo o no, manda: nunca se toca) ni activas ya. Por turnos entre
   países, sin las demasiado pesadas y sin las que se midieron hace poco sin ganar nada.
3. **Medición.** Se bajan las candidatas y se corre el matcher real sobre los canales sin guía
   (tools/source_coverage.py): cuántos canales quedarían con guía firme o dudosa con cada una.
   La misma medición dice cuánto suman todavía las automáticas ya activas.
4. **Decisión.** Se activan las que más suman por MB bajado, dentro de un presupuesto (cantidad,
   MB en total y nuevas por corrida), así la corrida no crece sin control. Una automática que ni
   se usa (perfiles y configuraciones) ni sumaría nada durante `RETIRE_RUNS` corridas seguidas
   se retira.

El estado vive en R2 (`state/auto_sources.json`, privado). La corrida siguiente lo baja antes
de fusionar (`pull`) y merge_epgs.py suma esas fuentes detrás de las de epg_urls.json: una
fuente activada hoy entra en la guía mañana.

Uso: `python tools/auto_sources.py pull` (antes de merge_epgs.py) y
`python tools/auto_sources.py update` (después de generate_playlist.py).
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import generate_playlist as gp  # noqa: E402
import source_coverage as sc  # noqa: E402
from merge_epgs import AUTO_SOURCES_PATH, CATALOG_PATH, load_catalog, load_sources  # noqa: E402
from source_alias import channel_alias  # noqa: E402

STATE_KEY = 'state/auto_sources.json'

MAX_AUTO_SOURCES = 30          # automáticas activas a la vez
MAX_AUTO_BYTES = 120 * 10**6   # MB comprimidos que suman entre todas (las manuales hoy son ~90 MB)
MAX_NEW_PER_RUN = 4            # nuevas por corrida: la guía crece de a poco
MAX_SOURCE_BYTES = 25 * 10**6  # una sola fuente más pesada no se activa sola (la de EE.UU. pesa 60 MB)
MAX_CANDIDATES = 12            # candidatas que se bajan para medir en cada corrida
MAX_MISSING = 6000             # canales sin guía que se miden (los primeros, por país)
MIN_FIRM = 1                   # al menos un canal con guía firme
MIN_VALUE_PER_MB = 0.2         # y que valga lo que pesa: ~1 canal firme cada 5 MB
DOUBTFUL_WEIGHT = 0.25         # una guía dudosa vale un cuarto de una firme
RETIRE_RUNS = 7                # corridas seguidas sin uso ni ganancia para retirarla
RETRY_DAYS = 7                 # una candidata que no sumó nada no se vuelve a bajar antes


# ------------------------------------------------------------------------------ estado

def empty_state():
    return {'version': 1, 'active': {}, 'tried': {}, 'retired': {}}


def parse_state(raw):
    try:
        state = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        state = {}
    out = empty_state()
    for key in ('active', 'tried', 'retired'):
        if isinstance(state.get(key), dict):
            out[key] = state[key]
    return out


# ------------------------------------------------------------------------------ demanda

def web_channels(configs, lists, real_of, section_rules):
    """Canales visibles de las configuraciones de Grilla web, con la forma de los del
    match_report (`xtream_name`, `category`, `chosen`…). Una configuración sin lista guardada
    (las M3U no se guardan) no suma demanda, pero lo que eligió igual cuenta como uso."""
    out, uses = [], []
    for cfg_id, cfg in configs.items():
        edits = cfg.get('channels') or {}
        groups = cfg.get('groups') or {}
        hidden_groups = set(groups.get('hidden') or [])
        no_epg = set(groups.get('noEpg') or [])
        for edit in edits.values():
            if isinstance(edit, dict) and isinstance(edit.get('epg'), str) and not edit.get('hidden'):
                real = real_of.get(edit['epg'])
                if real:
                    uses.append(real)
        for ch in (lists.get(cfg_id) or {}).get('channels') or []:
            name, category = ch.get('name'), ch.get('category') or ''
            if not name or gp.is_divider_category(category):
                continue
            edit = edits.get(name) if isinstance(edits.get(name), dict) else {}
            shown = edit.get('group') or category
            if edit.get('hidden') or shown in hidden_groups or category in hidden_groups:
                continue
            epg = edit.get('epg')
            chosen = real_of.get(epg) if isinstance(epg, str) else None
            # Sin guía a propósito: elegido "sin EPG" a mano o una categoría marcada sin guía.
            purpose = bool(edit.get('manual') and not epg) or category in no_epg or shown in no_epg
            section = gp.classify_section(category, section_rules)
            out.append({'xtream_name': name, 'category': category, 'section': section,
                        'shown_category': shown, 'shown_section': section, 'chosen': chosen,
                        'reason': 'override_none' if purpose else ('web' if chosen else None),
                        'alternatives': []})
    return out, uses


def usage_by_source(source_of, chosen_ids):
    used = {}
    for cid in chosen_ids:
        src = source_of(cid)
        if src:
            used[src] = used.get(src, 0) + 1
    return used


def cap_missing(missing, limit=MAX_MISSING):
    """Hasta `limit` canales sin guía, repartidos por turnos entre países (uno con miles de
    canales no se come la medición de los demás). Los sin país quedan al final."""
    by_country = {}
    for ch in missing:
        by_country.setdefault(sc.channel_country(ch) or '', []).append(ch)
    order = sorted(by_country, key=lambda c: (c == '', -len(by_country[c]), c))
    out = []
    for turn in range(max((len(v) for v in by_country.values()), default=0)):
        for c in order:
            if turn < len(by_country[c]):
                out.append(by_country[c][turn])
                if len(out) >= limit:
                    return out
    return out


# ------------------------------------------------------------------------------ decisión

def _days(a, b):
    try:
        return (datetime.date.fromisoformat(a) - datetime.date.fromisoformat(b)).days
    except (TypeError, ValueError):
        return 10**6


def pick_candidates(catalog, manual_ids, manual_urls, state, countries, today):
    """Fuentes fresh del catálogo para los países con canales sin guía: ni manuales, ni activas
    ya, ni demasiado pesadas, ni medidas hace menos de RETRY_DAYS sin sumar nada."""
    order = [c['country'] for c in countries if c['missing']]
    by_country = {c: [] for c in order}
    for s in catalog.values():
        tried = state['tried'].get(s['id']) or {}
        if (s.get('status') == 'fresh' and s.get('country') in by_country
                and s['id'] not in manual_ids and s.get('url') not in manual_urls
                and s['id'] not in state['active']
                and (s.get('size_bytes') or 0) <= MAX_SOURCE_BYTES
                and not (tried and not tried.get('firm') and _days(today, tried.get('at')) < RETRY_DAYS)):
            by_country[s['country']].append(s)
    for items in by_country.values():
        items.sort(key=lambda s: (-(s.get('live_channels') or 0), s['id']))
    picks = []
    for turn in range(max((len(v) for v in by_country.values()), default=0)):
        picks += [by_country[c][turn] for c in order if turn < len(by_country[c])]
    return picks[:MAX_CANDIDATES]


def value(gain):
    return gain.get('firm', 0) + DOUBTFUL_WEIGHT * gain.get('doubtful', 0)


def decide(state, catalog, candidates, gains, used, today):
    """Aplica la medición al estado: retira las automáticas que nadie usa hace RETIRE_RUNS
    corridas y activa las candidatas que más suman por MB, dentro del presupuesto. Devuelve
    (activadas, retiradas)."""
    retired = []
    for sid, info in list(state['active'].items()):
        in_use = used.get(sid, 0)
        potential = value(gains.get(sid) or {})
        info.update({'used': in_use, 'potential': round(potential, 2)})
        if in_use or potential or sid not in catalog:
            info['idle'] = 0
            if in_use or potential:
                info['last_used'] = today
        else:
            info['idle'] = info.get('idle', 0) + 1
        if info['idle'] >= RETIRE_RUNS or sid not in catalog:
            del state['active'][sid]
            state['retired'][sid] = {'at': today}
            retired.append(sid)

    for c in candidates:
        g = gains.get(c['id']) or {}
        state['tried'][c['id']] = {'at': today, 'firm': g.get('firm', 0), 'doubtful': g.get('doubtful', 0)}

    def mb(s):
        return max((s.get('size_bytes') or 0) / 10**6, 0.5)

    ranked = sorted(
        (c for c in candidates
         if (gains.get(c['id']) or {}).get('firm', 0) >= MIN_FIRM
         and value(gains[c['id']]) / mb(c) >= MIN_VALUE_PER_MB),
        key=lambda c: (-value(gains[c['id']]) / mb(c), -value(gains[c['id']]), c['id']),
    )
    total = sum((catalog.get(s) or {}).get('size_bytes') or 0 for s in state['active'])
    activated = []
    for c in ranked:
        size = c.get('size_bytes') or 0
        if (len(activated) >= MAX_NEW_PER_RUN or len(state['active']) >= MAX_AUTO_SOURCES
                or total + size > MAX_AUTO_BYTES):
            continue
        g = gains[c['id']]
        state['active'][c['id']] = {'since': today, 'last_used': today, 'idle': 0,
                                    'firm': g.get('firm', 0), 'doubtful': g.get('doubtful', 0)}
        state['retired'].pop(c['id'], None)
        total += size
        activated.append(c['id'])
    # Lo medido hace mucho ya no sirve para nada: el registro no crece sin fin.
    state['tried'] = {k: v for k, v in state['tried'].items() if _days(today, v.get('at')) < 60}
    state['retired'] = {k: v for k, v in state['retired'].items() if _days(today, v.get('at')) < 60}
    state['updated'] = today
    return activated, retired


def run(state, reports, channel_map, configs, lists, manual_entries, catalog, channels_root, sections, rules,
        fetch, today):
    """Una pasada completa sobre el estado (lo modifica). `fetch(urls)` → [(url, bytes)]."""
    _, section_rules, _, _ = sections
    source_attr = {ch.get('id'): ch.get('source') for ch in channels_root}
    real_of = {}
    for cid in source_attr:
        if cid:
            real_of.setdefault(cid, cid)
            real_of.setdefault(channel_alias(cid), cid)

    channels = sc.visible_channels(reports, channel_map, section_rules)
    web, web_uses = web_channels(configs, lists, real_of, section_rules)
    seen = {ch['xtream_name'] for ch in channels}
    channels += [ch for ch in web if ch['xtream_name'] not in seen and not seen.add(ch['xtream_name'])]
    missing = sc.missing_channels(channels, sc._NoEpg(rules, channel_map))

    used = usage_by_source(source_attr.get, [ch['chosen'] for ch in channels if ch.get('chosen')] + web_uses)

    active_sources = {s['id']: {'country': s.get('country'), 'priority': s['priority']} for s in manual_entries['active']}
    for i, sid in enumerate(state['active']):
        known = catalog.get(sid) or {}
        active_sources.setdefault(sid, {'country': known.get('country'), 'priority': 1000 + i})
    country_attr = {}
    for cid, src in source_attr.items():
        tail = (cid or '').rsplit('.', 1)[-1]
        country_attr[cid] = tail if len(tail) == 2 and tail.isalpha() else (active_sources.get(src) or {}).get('country')
    countries = sc.detect_countries(channels, missing, country_attr.get)

    candidates = pick_candidates(catalog, manual_entries['ids'], manual_entries['urls'], state, countries, today)
    measured = cap_missing(missing)
    gains = {}
    if measured and (candidates or state['active']):
        data = dict(fetch([c['url'] for c in candidates])) if candidates else {}
        overrides = {k: v for k, v in (channel_map.get('overrides') or {}).items() if v}
        # Las automáticas ya activas van como candidatas sin datos: sus canales ya están en la guía,
        # así la misma pasada del matcher dice cuánto sumaría cada una.
        pseudo = [{'id': sid} for sid in state['active']]
        now = datetime.datetime.combine(datetime.date.fromisoformat(today), datetime.time(12),
                                        tzinfo=datetime.timezone.utc)
        gains, _ = sc.measure_suggestions(
            channels_root, active_sources, candidates + pseudo,
            [(c, data.get(c['url'])) for c in candidates], measured, overrides, sections, now)
    activated, retired = decide(state, catalog, candidates, gains, used, today)
    return {'countries': countries, 'missing': len(missing), 'measured': len(measured),
            'candidates': [c['id'] for c in candidates], 'gains': gains,
            'activated': activated, 'retired': retired}


def manual_sources():
    """Lo que dice epg_urls.json (activo o no): ids y URLs que la automática no toca."""
    entries = sc.load_user_sources()
    return {'ids': {s['id'] for s in entries}, 'urls': {s['url'] for s in entries if s.get('url')},
            'active': load_sources(auto_path=None)}


# ------------------------------------------------------------------------------ R2 y main

def r2_client():
    needed = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if not all(os.environ.get(k) for k in needed):
        return None
    import boto3
    from r2 import R2
    client = boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')
    return R2(client, os.environ.get('R2_BUCKET') or 'grilla')


def read_json(r2, key):
    got = r2.get(key)
    if not got:
        return None
    try:
        return json.loads(got[0])
    except ValueError:
        return None


def load_web(r2):
    """({cfgId: config}, {cfgId: lista guardada}) de R2."""
    configs, lists = {}, {}
    for key in r2.keys('cfg/'):
        cfg_id = key[len('cfg/'):].rsplit('.', 1)[0]
        cfg = read_json(r2, key) if key.endswith('.json') else None
        if isinstance(cfg, dict):
            configs[cfg_id] = cfg
    for key in r2.keys('list/'):
        cfg_id = key[len('list/'):].rsplit('.', 1)[0]
        if cfg_id in configs:
            lst = read_json(r2, key)
            if isinstance(lst, dict):
                lists[cfg_id] = lst
    return configs, lists


def cmd_pull(r2, path=AUTO_SOURCES_PATH):
    raw = r2.get(STATE_KEY) if r2 else None
    state = parse_state(raw[0] if raw else None)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    print(f"🤖 Fuentes automáticas para esta corrida: {len(state['active'])}")
    return 0


def cmd_update(r2, merged, today=None):
    from epg_http import download_all
    today = today or datetime.date.today().isoformat()
    raw = r2.get(STATE_KEY)
    state = parse_state(raw[0] if raw else None)
    configs, lists = load_web(r2)
    rules = gp.load_provider_rules()
    gp.set_provider_rules(rules)
    result = run(state, sc.load_reports(), sc.load_map(), configs, lists, manual_sources(),
                 load_catalog(CATALOG_PATH), gp.load_epg_channels(merged), gp.load_sections_config(), rules,
                 lambda urls: list(download_all(urls, workers=4)), today)
    r2.put(STATE_KEY, json.dumps(state, ensure_ascii=False, indent=1).encode())
    print(f"🤖 Demanda: {result['missing']} canales sin guía ({len(configs)} configuraciones web), "
          f"{result['measured']} medidos; países: "
          + ', '.join(f"{c['country']}={c['missing']}" for c in result['countries'] if c['missing'])[:300])
    for sid in result['candidates']:
        g = result['gains'].get(sid) or {}
        print(f"   · {sid}: {g.get('firm', 0)} firmes, {g.get('doubtful', 0)} dudosos")
    print(f"✅ Activadas: {', '.join(result['activated']) or 'ninguna'}; "
          f"retiradas: {', '.join(result['retired']) or 'ninguna'}; "
          f"automáticas activas: {len(state['active'])}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('command', choices=('pull', 'update'))
    ap.add_argument('--merged', default=gp.MERGED_EPG_PATH)
    args = ap.parse_args(argv)
    r2 = r2_client()
    if args.command == 'pull':
        return cmd_pull(r2)
    if not r2:
        print('ℹ️  Sin credenciales de R2: las fuentes automáticas no se actualizan')
        return 0
    return cmd_update(r2, args.merged)


if __name__ == '__main__':
    sys.exit(main())
