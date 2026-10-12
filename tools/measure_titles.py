"""Mide, sin llamar a ninguna IA, cuánto costaría clasificar por género la programación de la guía
(fase 2 de planes/recomendaciones.md). Corre en la corrida diaria, después de generate_playlist.py.

Lee la programación por canal que deja la corrida (out/schedule/<sha1 del canal, 16>.json, entradas
[inicio, fin, título, descripción?]) y cuenta los títulos distintos: en toda la guía y solo en los
canales que usa alguna configuración de Grilla web (cfg/<cfgId>.json en R2, el epg de cada canal).
Un título se clasificaría una sola vez, así que lo que cuenta por día son los nuevos: se recuerdan en
R2 (ai/seen.json, un hash corto por título con el primer y el último día en que apareció).

Deja el resultado del día en ai/measure.json (historial) y en el resumen de la corrida de GitHub,
con la proyección del costo mensual con Claude Haiku 5.5 por lotes (Batch API). Sin R2 mide igual
la guía de hoy, pero no puede saber cuáles son nuevos.
"""
import datetime
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.dirname(HERE)]

SCHEDULE_DIR = os.path.join('out', 'schedule')
SEEN_KEY = 'ai/seen.json'
MEASURE_KEY = 'ai/measure.json'
FORGET_DAYS = 60   # un título que no aparece hace dos meses se vuelve a contar como nuevo
HISTORY_DAYS = 90
# Desde 5 minutos se clasifica: los dibujitos y otros programas cortos (Peppa Pig, Cuquín, 10 a 20 min) también
# necesitan género para el filtro de la Guía, la búsqueda por tema y un perfil infantil. Menos de 5 minutos son
# avances, sorteos, cortes y clips que no son un programa. Tu plan sigue sin sugerir nada de menos de 25 minutos
# (planScore en worker/web/ui/guide.tsx): eso lo decide la web, no esta medición.
MIN_CLASSIFY = 5 * 60

# Como en el Worker (src/again.ts) y la web (ui/guide.tsx): mismo título aunque cambien mayúsculas o espacios.
GENERIC = {'paid programming', 'programa pagado', 'programación pagada', 'no data', 'sin información', 'movie',
           'película', 'pelicula', 'to be announced', 'tba', 'off air', 'fuera del aire', 'programación', 'programacion'}
FILLER = re.compile(r'paid programming|programa pagado|programación pagada|no data|sin información|infomercial|'
                    r'televenta|fuera del aire|off air|cierre de emisi', re.I)

# Supuestos del costo (planes/recomendaciones.md): Claude Haiku 5.5 por lotes (la mitad del precio normal),
# en tandas de 50 títulos con las instrucciones (~1000 tokens) en cada tanda, la descripción recortada
# a 300 caracteres y ~25 tokens de respuesta por título (género y hasta 3 temas, sin «pensar»).
PRICE_IN = 0.10 / 2 / 1e6
PRICE_OUT = 0.50 / 2 / 1e6
BATCH = 50
SYSTEM_TOKENS = 1000
DESC_CHARS = 300
OUT_TOKENS = 25
PER_TITLE_OVERHEAD = 8  # numeración y separadores de cada título en la tanda


def norm(title):
    return ' '.join(title.split()).lower()


def title_key(title):
    return hashlib.sha1(norm(title).encode('utf-8')).hexdigest()[:12]


def schedule_file(epg):
    """Como generate_playlist.py: el archivo va por el alias del canal (las configuraciones viejas guardan el id)."""
    from source_alias import channel_alias
    return hashlib.sha1(channel_alias(epg).encode('utf-8')).hexdigest()[:16]


def tokens(text):
    """Tokens aproximados de un texto en castellano (unos 3,5 bytes por token)."""
    return max(1, round(len(text.encode('utf-8')) / 3.5))


def collect(schedule_dir, only=None):
    """{clave: (título, descripción, si vale clasificarlo, peso, emisiones)} de los archivos por canal; `only` limita a
    esos archivos (o a {archivo: configuraciones que lo usan}, de used_files: el peso del título es el de su canal más
    usado, y las emisiones son las veces que aparece en la programación)."""
    titles = {}
    for name in os.listdir(schedule_dir):
        if not name.endswith('.json') or (only is not None and name[:-5] not in only):
            continue
        try:
            with open(os.path.join(schedule_dir, name), encoding='utf-8') as f:
                entries = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(entries, list):
            continue
        for e in entries:
            if not isinstance(e, list) or len(e) < 3 or not isinstance(e[2], str):
                continue
            t = e[2].strip()
            if not t or norm(t) in GENERIC or FILLER.search(t):
                continue
            desc = e[3] if len(e) > 3 and isinstance(e[3], str) else ''
            plan = e[1] - e[0] >= MIN_CLASSIFY
            weight = only.get(name[:-5], 0) if isinstance(only, dict) else 0
            k = title_key(t)
            prev = titles.get(k)
            count = 1
            if prev:
                # La descripción más larga describe mejor; si alguna emisión dura lo suficiente, el título entra.
                t, desc, plan = prev[0], desc if len(desc) > len(prev[1]) else prev[1], plan or prev[2]
                weight, count = max(weight, prev[3]), prev[4] + 1
            titles[k] = (t, desc, plan, weight, count)
    return titles


def used_files(configs):
    """{archivo de programación: cuántas configuraciones lo usan} de los canales que tienen guía en alguna
    configuración (una configuración cuenta una vez por canal aunque lo repita)."""
    files = {}
    for cfg in configs.values():
        mine = set()
        for edit in (cfg.get('channels') or {}).values():
            epg = edit.get('epg') if isinstance(edit, dict) else None
            if isinstance(epg, str) and epg:
                mine.add(schedule_file(epg))
        for f in mine:
            files[f] = files.get(f, 0) + 1
    return files


def cost(titles):
    """Tokens de entrada y salida y costo en dólares de clasificar estos títulos."""
    if not titles:
        return 0, 0, 0.0
    tin = sum(tokens(t) + tokens(d[:DESC_CHARS]) if d else tokens(t) for t, d, *_ in titles) + PER_TITLE_OVERHEAD * len(titles)
    tin += SYSTEM_TOKENS * -(-len(titles) // BATCH)
    tout = OUT_TOKENS * len(titles)
    return tin, tout, tin * PRICE_IN + tout * PRICE_OUT


def update_seen(seen, keys, today):
    """Marca las claves de hoy y devuelve las nuevas; olvida lo que no aparece hace FORGET_DAYS."""
    new = [k for k in keys if k not in seen]
    for k in keys:
        first = seen.get(k, [today, today])[0]
        seen[k] = [first, today]
    limit = (datetime.date.fromisoformat(today) - datetime.timedelta(days=FORGET_DAYS)).isoformat()
    for k in [k for k, (_, last) in seen.items() if last < limit]:
        del seen[k]
    return new


def measure(schedule_dir, configs, seen, today):
    """La medición del día: totales, nuevos y costo, en toda la guía y en los canales en uso."""
    everything = collect(schedule_dir)
    used = collect(schedule_dir, used_files(configs)) if configs else {}
    known = bool(seen)
    new_all = update_seen(seen, list(everything), today)
    row = {'date': today, 'configs': len(configs), 'first_run': not known}
    scopes = [('all', everything, new_all)]
    if configs:
        scopes.append(('used', used, [k for k in new_all if k in used]))
    for name, titles, new in scopes:
        plan = [k for k, v in titles.items() if v[2]]
        new_plan = [k for k in new if titles[k][2]]
        _, _, c_total = cost([titles[k] for k in plan])
        tin, tout, c_new = cost([titles[k] for k in new_plan])
        row[name] = {
            'titles': len(titles), 'plan_titles': len(plan), 'with_desc': sum(1 for v in titles.values() if v[1]),
            'new': len(new), 'new_plan': len(new_plan),
            'new_tokens_in': tin, 'new_tokens_out': tout, 'new_cost': round(c_new, 4), 'backlog_cost': round(c_total, 4),
            'samples': sorted(titles[k][0] for k in new_plan)[:15] if known else sorted(titles[k][0] for k in plan)[:15],
        }
    return row


def monthly(history, scope):
    """Promedio de títulos nuevos por día (sin el primer día) y su costo mensual."""
    days = [r[scope] for r in history if not r.get('first_run') and scope in r]
    if not days:
        return None
    avg_new = sum(d['new_plan'] for d in days) / len(days)
    avg_cost = sum(d['new_cost'] for d in days) / len(days)
    return {'days': len(days), 'new_per_day': round(avg_new), 'cost_month': round(avg_cost * 30, 2)}


def usd(x):
    return f'US$ {x:,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')


def summary(row, history):
    """El resumen en Markdown para la corrida de GitHub."""
    lines = ['## Clasificar la guía con IA: medición (sin costo)', '',
             'Lo que costaría clasificar por género con Claude Haiku 5.5 por lotes. Cuentan los títulos de '
             '5 minutos o más (los cortes y avisos más cortos no son un programa).', '']
    lines += ['| | Toda la guía | Canales en uso |', '|---|---|---|']
    a, u = row['all'], row.get('used') or {}
    def cell(d, k, fmt=str):
        return fmt(d[k]) if d and k in d else '—'
    lines += [f"| Títulos distintos hoy | {cell(a, 'plan_titles')} | {cell(u, 'plan_titles')} |",
              f"| Clasificar todo de una vez | {cell(a, 'backlog_cost', usd)} | {cell(u, 'backlog_cost', usd)} |"]
    if not row['first_run']:
        lines += [f"| Nuevos hoy | {cell(a, 'new_plan')} | {cell(u, 'new_plan')} |",
                  f"| Costo de los nuevos de hoy | {cell(a, 'new_cost', usd)} | {cell(u, 'new_cost', usd)} |"]
    for scope, label in (('all', 'toda la guía'), ('used', 'los canales en uso')):
        m = monthly(history, scope)
        if m:
            lines.append(f"\n**Por mes ({label})**: ~{m['new_per_day']} títulos nuevos por día → ~{usd(m['cost_month'])} "
                         f"(promedio de {m['days']} días).")
    if row['first_run']:
        lines.append('\nPrimer día: todavía no se sabe cuáles son nuevos. Desde mañana se cuentan.')
    sample = (u or a).get('samples') or []
    if sample:
        lines += ['', '<details><summary>Algunos títulos' + (' nuevos' if not row['first_run'] else '') + '</summary>', '']
        lines += [f'- {t}' for t in sample] + ['', '</details>']
    return '\n'.join(lines) + '\n'


def main(argv=None):
    from auto_sources import load_web, r2_client, read_json

    if not os.path.isdir(SCHEDULE_DIR):
        print(f'ℹ️  No hay {SCHEDULE_DIR}: nada que medir.')
        return 0
    r2 = r2_client()
    configs = load_web(r2)[0] if r2 else {}
    seen = (read_json(r2, SEEN_KEY) if r2 else None) or {}
    history = (read_json(r2, MEASURE_KEY) if r2 else None) or []
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    row = measure(SCHEDULE_DIR, configs, seen, today)
    history = [r for r in history if r.get('date') != today] + [row]
    history = history[-HISTORY_DAYS:]
    if r2:
        r2.put(SEEN_KEY, json.dumps(seen, separators=(',', ':')).encode('utf-8'))
        r2.put(MEASURE_KEY, json.dumps(history, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    text = summary(row, history)
    print(text)
    out = os.environ.get('GITHUB_STEP_SUMMARY')
    if out:
        with open(out, 'a', encoding='utf-8') as f:
            f.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
