#!/usr/bin/env python3
"""Banco de prueba del matcher: qué tan bien asigna el EPG en listas que no son de Luis.

Corre el matching real (`generate_playlist.match_stream`) sobre:

- **listas públicas** congeladas en `bench/lists/<nombre>.m3u` (iptv-org, por país);
- **la lista de Luis** (opcional, `--luis`): los canales de su `match_report` publicado, contra
  sus overrides de `xtream_channel_map.json` (el EPG que eligió a mano), sin esos overrides.

Respuestas correctas, por canal (nombre crudo):
- `bench/labels/<nombre>.json`, revisadas a mano: `"id"`, `["id1", "id2"]` (cualquiera
  sirve) o `null` (no hay guía correcta: cualquier asignación es un error);
- automáticas: el `tvg-id` de la lista sin el sufijo `@…`, si ese canal existe en la guía.

Un match es correcto si es un id esperado o **el mismo canal en otra fuente** (mismo nombre
normalizado y mismo país). Dos modos: con `tvg-id` (lo real) y solo por nombre (sin
`tvg-id`, para medir el match por nombre en los canales que la lista ya trae bien).

Uso: `python tools/match_benchmark.py --merged merged.xml.gz [--luis report.json] [--json out.json]`.
"""
import argparse
import collections
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import generate_playlist as gp  # noqa: E402
from channel_names import flag_to_country_code, strip_accents  # noqa: E402
from channel_db import load_channel_db  # noqa: E402
from epg_index import EpgIndex  # noqa: E402
from merge_epgs import load_sources  # noqa: E402
from providers import parse_m3u  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BENCH_DIR = os.path.join(ROOT, 'bench')
GOOD_SCORE = 0.8  # lo que la interfaz muestra como "Bien"


def tvg_base(tvg_id):
    """'TelefeRosario.ar@SD' -> 'TelefeRosario.ar'."""
    return (tvg_id or '').split('@')[0].strip()


class Judge:
    """Decide si un channel_id elegido es el esperado (o el mismo canal en otra fuente)."""

    def __init__(self, index):
        self.index = index
        self.by_lower = {}
        for cid in index.parsed:
            self.by_lower.setdefault(cid.lower().replace(' ', ''), cid)

    def resolve(self, tvg_id):
        return self.by_lower.get(tvg_base(tvg_id).lower().replace(' ', ''))

    def _keys(self, cid):
        # Cualquiera de sus nombres, sin espacios, calidad ni número de canal del final: "Das
        # Erste", "DasErste" y "Rai 1 HD  101" / "Rai1" son lo mismo. El país tiene que
        # coincidir ("Canale 5" de Alemania no es el de Italia).
        country = self.index.country.get(cid)
        quality = self.index.rules.quality_tokens
        names = set()
        for p in self.index.parsed.get(cid) or []:
            raw = re.sub(r'\s{2,}\d+\s*$', '', strip_accents(p.raw or '')).lower()
            raw = re.sub(r'\([^)]*\)', ' ', raw)
            tokens = [t for t in re.sub(r'[^a-z0-9]+', ' ', raw).split() if t not in quality]
            if tokens:
                names.add(''.join(tokens))
            if p.core:  # también sin las palabras de país ("ESPN Argentina" = "ESPN" de .ar)
                names.add(''.join(p.core))
        # Algunas fuentes usan el id como nombre ("DasErste.de"): sin el país del final.
        if country:
            names |= {n[:-len(country)] for n in names if n.endswith(country) and len(n) > len(country) + 2}
        return names, country

    def same(self, chosen, expected):
        if chosen == expected:
            return True
        if chosen not in self.index or expected not in self.index:
            return False
        (a, ca), (b, cb) = self._keys(chosen), self._keys(expected)
        return ca == cb and bool(a & b)


def load_labels(name):
    path = os.path.join(BENCH_DIR, 'labels', f'{name}.json')
    try:
        with open(path, encoding='utf-8') as f:
            return {k: v for k, v in json.load(f).items() if not k.startswith('_')}
    except FileNotFoundError:
        return {}


def evaluate(cases, index, judge, use_tvg_id=True):
    """cases: [{name, category, tvg_id, expected (lista de ids o [] = ninguno), country,
    epg_config}]. Devuelve métricas y los errores."""
    m = collections.Counter()
    errors = []
    for case in cases:
        tvg = case['tvg_id'] if use_tvg_id else None
        _, cid, reason, score, _ = gp.match_stream(
            case['name'], tvg, index, {}, case.get('epg_config') or {}, case.get('country'),
        )
        m['total'] += 1
        if cid:
            m['assigned'] += 1
            m['good' if score >= GOOD_SCORE else 'doubtful'] += 1
        if case['expected'] is None:
            continue
        m['labeled'] += 1
        band = 'good' if cid and score >= GOOD_SCORE else 'doubtful' if cid else 'none'
        # "!id" en la etiqueta = ese id está mal (se sabe que es un error, no cuál es el correcto).
        expected = [e for e in case['expected'] if not e.startswith('!')]
        forbidden = [e[1:] for e in case['expected'] if e.startswith('!')]
        if not cid:
            m['missed' if expected else 'right_none'] += 1
            continue
        if any(judge.same(cid, e) for e in forbidden):
            ok = False
        elif expected:
            ok = any(judge.same(cid, e) for e in expected)
        else:
            m['labeled'] -= 1  # eligió otra cosa: no se sabe si está bien
            continue
        m[f'{band}_{"ok" if ok else "wrong"}'] += 1
        if not ok:
            errors.append({'channel': case['name'], 'chosen': cid,
                           'chosen_name': index.display_name.get(cid), 'score': round(score, 2),
                           'expected': expected[:2], 'reason': reason})
    return m, errors


def list_cases(path, judge):
    name = os.path.splitext(os.path.basename(path))[0]
    labels = load_labels(name)
    with open(path, encoding='utf-8') as f:
        channels = parse_m3u(f.read())
    cases = []
    for ch in channels:
        raw = ch['name']
        if raw in labels:
            exp = labels[raw]
            expected = [] if exp is None else ([exp] if isinstance(exp, str) else list(exp))
        else:
            auto = judge.resolve(ch['epg_channel_id'])
            expected = [auto] if auto else None  # None = sin etiqueta
        cases.append({'name': raw, 'category': ch['category'], 'tvg_id': ch['epg_channel_id'],
                      'expected': expected, 'country': None, 'epg_config': {}})
    return name, cases


def luis_cases(report_path, map_path, sections):
    with open(report_path, encoding='utf-8') as f:
        report = json.load(f)['channels']
    with open(map_path, encoding='utf-8') as f:
        overrides = json.load(f).get('overrides') or {}
    _, section_rules, section_epg, _ = sections
    cases = []
    for ch in report:
        if gp.is_divider_category(ch['category']):
            continue
        expected = overrides.get(ch['xtream_name'], '__none__')
        if expected == '__none__' or expected is None:
            continue  # solo lo que Luis eligió a mano
        section = gp.classify_section(ch['category'], section_rules)
        cases.append({'name': ch['xtream_name'], 'category': ch['category'], 'tvg_id': None,
                      'expected': [expected], 'country': flag_to_country_code(ch['category']),
                      'epg_config': section_epg.get(section, {})})
    return cases


def luis_auto(report_path, map_path, sections, index):
    """{canal: channel_id} del matching automático sobre los canales de Luis sin override.
    Guardado antes de un cambio y comparado después (`--luis-save` / `--luis-compare`), con la
    misma guía, muestra exactamente qué canales suyos cambiarían."""
    with open(report_path, encoding='utf-8') as f:
        report = json.load(f)['channels']
    with open(map_path, encoding='utf-8') as f:
        overrides = json.load(f).get('overrides') or {}
    _, section_rules, section_epg, _ = sections
    out = {}
    for ch in report:
        name = ch['xtream_name']
        if name in overrides or gp.is_divider_category(ch['category']):
            continue
        section = gp.classify_section(ch['category'], section_rules)
        # Igual que la corrida con un perfil Xtream (el id de EPG del proveedor, si el reporte
        # lo trae, sin confiar en su país).
        _, cid, _, _, _ = gp.match_stream(name, ch.get('provider_epg_id'), index, {},
                                          section_epg.get(section, {}), flag_to_country_code(ch['category']),
                                          trust_list_ids=False)
        out[name] = cid
    return out


def pct(a, b):
    return f'{100 * a / b:.0f}%' if b else '—'


def summary_row(name, m):
    good = m['good_ok'] + m['good_wrong']
    doubt = m['doubtful_ok'] + m['doubtful_wrong']
    return {
        'lista': name,
        'canales': m['total'],
        'cobertura': pct(m['assigned'], m['total']),
        'etiquetados': m['labeled'],
        'aciertos': m['good_ok'] + m['doubtful_ok'] + m['right_none'],
        'errores': m['good_wrong'] + m['doubtful_wrong'],
        'sin_asignar': m['missed'],
        'precision_asignado': pct(m['good_ok'] + m['doubtful_ok'], good + doubt),
        'precision_bien': pct(m['good_ok'], good),
        'precision_dudoso': pct(m['doubtful_ok'], doubt),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--merged', default=gp.MERGED_EPG_PATH)
    ap.add_argument('--luis', help='match_report de Luis (JSON) para medir contra sus overrides')
    ap.add_argument('--map', default=os.path.join(ROOT, gp.CHANNEL_MAP_PATH))
    ap.add_argument('--channel-db', default=os.path.join(ROOT, 'iptv_channels.json'),
                    help="diccionario de iptv-org (channel_db.py); '' para no usarlo")
    ap.add_argument('--luis-save', help='guardar el EPG automático de los canales de Luis (antes de un cambio)')
    ap.add_argument('--luis-compare', help='comparar contra un --luis-save anterior')
    ap.add_argument('--json', help='guardar métricas y errores en este archivo')
    ap.add_argument('--errors', type=int, default=8, help='errores de ejemplo por lista')
    args = ap.parse_args(argv)

    root = gp.load_epg_channels(args.merged)
    sources = {s['id']: s for s in load_sources(os.path.join(ROOT, 'epg_urls.json'),
                                                os.path.join(ROOT, 'epg_sources_catalog.json'))}
    index = EpgIndex(root, sources=sources)
    judge = Judge(index)
    db = load_channel_db(args.channel_db, index.rules) if args.channel_db else None
    gp.set_channel_db(db)
    print(f"Diccionario de iptv-org: {len(db) if db else 'no'}")

    rows, detail = [], {}
    # Listas públicas: reglas genéricas (no son del proveedor de Luis).
    gp.set_provider_rules(gp.load_provider_rules(os.path.join(ROOT, '__sin_reglas__.json')))
    for path in sorted(glob.glob(os.path.join(BENCH_DIR, 'lists', '*.m3u'))):
        name, cases = list_cases(path, judge)
        for mode, use_tvg in (('', True), (' (solo nombre)', False)):
            m, errors = evaluate(cases, index, judge, use_tvg)
            rows.append(summary_row(name + mode, m))
            detail[name + mode] = {'metrics': dict(m), 'errors': errors}

    if args.luis:
        gp.set_provider_rules(gp.load_provider_rules(os.path.join(ROOT, gp.PROVIDER_RULES_PATH)))
        sections = gp.load_sections_config(os.path.join(ROOT, gp.SECTIONS_CONFIG_PATH))
        cases = luis_cases(args.luis, args.map, sections)
        m, errors = evaluate(cases, index, judge, False)
        rows.append(summary_row('luis (vs overrides)', m))
        detail['luis (vs overrides)'] = {'metrics': dict(m), 'errors': errors}
        auto = luis_auto(args.luis, args.map, sections, index)
        if args.luis_save:
            with open(args.luis_save, 'w', encoding='utf-8') as f:
                json.dump(auto, f, ensure_ascii=False)
        if args.luis_compare:
            with open(args.luis_compare, encoding='utf-8') as f:
                before = json.load(f)
            changes = [{'channel': n, 'chosen': cid, 'chosen_name': index.display_name.get(cid),
                        'score': None, 'expected': [before.get(n), index.display_name.get(before.get(n))],
                        'reason': 'antes'}
                       for n, cid in auto.items() if n in before and before[n] != cid]
            detail['luis (cambios)'] = {'metrics': {}, 'errors': changes}

    # El total es de las listas públicas. Los overrides de Luis son justo los canales donde el
    # matcher se equivocaba (por eso los eligió a mano): miden regresión, no precisión.
    total = collections.Counter()
    for key, d in detail.items():
        if '(solo nombre)' not in key and not key.startswith('luis'):
            total.update(d['metrics'])
    rows.append(summary_row('TOTAL listas', total))

    cols = list(rows[0])
    widths = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in cols}
    print('  '.join(c.ljust(widths[c]) for c in cols))
    for r in rows:
        print('  '.join(str(r[c]).ljust(widths[c]) for c in cols))
    if 'luis (cambios)' in detail:
        print(f"\nCanales de Luis sin override que cambian: {len(detail['luis (cambios)']['errors'])}")
    for key, d in detail.items():
        if d['errors'] and args.errors:
            print(f'\n✗ {key}:')
            for e in d['errors'][:args.errors]:
                print(f"   {e['channel']!r} → {e['chosen_name']!r} ({e['chosen']}, {e['score']}) "
                      f"esperado {e['expected']}")
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump({'rows': rows, 'detail': detail}, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
