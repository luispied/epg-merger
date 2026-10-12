"""Clasifica con IA los programas de la guía por género y temas (planes/recomendaciones.md, fase 2).
Corre en la corrida diaria, después de measure_titles.py, sobre la programación por canal que deja
generate_playlist.py (out/schedule/), y solo en los canales que usa alguna configuración.

Cada título se clasifica una sola vez: el resultado queda en R2 (ai/genres.json, {clave del título:
[género, [temas], en vivo, día]}) y no se vuelve a mandar. Al modelo solo le llega la guía pública
(título y descripción): nada de lo que mira cada uno.

Dos formas de correr:
- **Prueba** (`AI_SAMPLE=<n>`, desde «Run workflow» de Merge EPGs): clasifica n títulos de ejemplo y deja
  una página con las muestras (out/ai_sample.html, en los artefactos de la corrida) y una tabla en el resumen.
- **Diaria**, solo con el interruptor prendido (variable del repo `AI_CLASSIFY` = `on`): los títulos nuevos,
  como mucho `AI_MAX_TITLES` por corrida.

Usa Claude Haiku 5.5 por la API de lotes (la mitad del precio). Si el lote no termina en `AI_WAIT_MIN`
minutos, queda anotado en ai/pending.json y lo recoge la corrida siguiente. Sin `ANTHROPIC_API_KEY` no hace
nada. Lo que gasta cada corrida queda en ai/spend.json y en el resumen.
"""
import datetime
import html
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.dirname(HERE)]

import measure_titles as mt  # noqa: E402

MODEL = 'claude-haiku-5-5'
GENRES_KEY = 'ai/genres.json'
PENDING_KEY = 'ai/pending.json'
SPEND_KEY = 'ai/spend.json'
SAMPLE_PAGE = os.path.join('out', 'ai_sample.html')
PER_REQUEST = 50
MAX_TOPICS = 3

GENRES = ['Película', 'Serie', 'Telenovela', 'Deportes', 'Noticias', 'Documental', 'Infantil', 'Entretenimiento',
          'Reality', 'Música', 'Cocina', 'Estilo de vida', 'Humor', 'Religión', 'Educativo', 'Publicidad', 'Otro']
# Lo que Tu plan nunca sugiere aunque el programa dure 25 minutos o más.
NEVER_SUGGEST = {'Publicidad'}

SYSTEM = f"""Clasificás programas de una guía de TV de Latinoamérica para un recomendador.
Para cada programa numerado recibís el título y, a veces, la descripción. Devolvé, para cada número:
- genero: uno solo de esta lista: {', '.join(GENRES)}.
- temas: hasta {MAX_TOPICS} temas cortos en castellano y en minúscula que sirvan para encontrar programas parecidos
  (subgénero, deporte, liga, equipos, país, público). Los nombres propios, como van. Sin repetir el género ni el
  nombre del programa: «Blue Bloods» → «policial, nueva york», no «blue bloods».
- Publicidad: infomerciales, televentas y avisos que venden un producto («llame ya», cremas, monedas, aparatos).
- vivo: true solo si el título o la descripción dicen que es en vivo o en directo.
Si no hay descripción, clasificá por el título: si reconocés la película, la serie o el programa, usá lo que sabés de él
(«Robot Salvaje» → Infantil). «Otro» solo si de verdad no se puede saber qué es."""

SCHEMA = {
    'type': 'object',
    'properties': {'items': {'type': 'array', 'items': {
        'type': 'object',
        'properties': {'n': {'type': 'integer'}, 'genero': {'type': 'string', 'enum': GENRES},
                       'temas': {'type': 'array', 'items': {'type': 'string'}}, 'vivo': {'type': 'boolean'}},
        'required': ['n', 'genero', 'temas', 'vivo'], 'additionalProperties': False}}},
    'required': ['items'], 'additionalProperties': False,
}


def prompt(titles):
    """El pedido de una tanda: los títulos numerados desde 1, con la descripción recortada."""
    lines = []
    for i, (title, desc) in enumerate(titles, 1):
        desc = ' '.join(desc.split())[:mt.DESC_CHARS]
        lines.append(f'{i}. {title}' + (f' — {desc}' if desc else ''))
    return '\n'.join(lines)


def requests_for(keys, titles):
    """Los pedidos del lote, de a PER_REQUEST títulos: [(custom_id, claves, params)]."""
    out = []
    for start in range(0, len(keys), PER_REQUEST):
        chunk = keys[start:start + PER_REQUEST]
        params = {
            'model': MODEL, 'max_tokens': 8000,
            # Es una etiqueta, no un razonamiento: esfuerzo bajo para que piense lo mínimo.
            'output_config': {'effort': 'low', 'format': {'type': 'json_schema', 'schema': SCHEMA}},
            'system': SYSTEM,
            'messages': [{'role': 'user', 'content': prompt([titles[k][:2] for k in chunk])}],
        }
        out.append((f'c{start // PER_REQUEST}', chunk, params))
    return out


def show_name(title):
    """El nombre del programa, sin episodio ni temporada: «Blue Bloods · Cerca de casa» → «blue bloods»."""
    return mt.norm(title.split(' · ')[0].split(':')[0])


def parse(text, chunk, today, names=None):
    """{clave: [género, temas, vivo, día]} de la respuesta de una tanda; ignora números fuera de rango y los
    temas que repiten el nombre del programa (`names`: {clave: título}), que no sirven para buscar parecidos."""
    out = {}
    for item in json.loads(text).get('items', []):
        n = item.get('n')
        if not isinstance(n, int) or not 1 <= n <= len(chunk) or item.get('genero') not in GENRES:
            continue
        key = chunk[n - 1]
        name = show_name((names or {}).get(key, ''))
        topics = [' '.join(str(t).split()) for t in item.get('temas') or [] if str(t).strip()]
        topics = [t for t in topics if mt.norm(t) != name][:MAX_TOPICS]
        out[key] = [item['genero'], topics, bool(item.get('vivo')), today]
    return out


def collect_batch(client, batch_id, chunks, today, names=None):
    """Resultados de un lote terminado: ({clave: etiqueta}, tokens de entrada, tokens de salida, errores)."""
    genres, tin, tout, errors = {}, 0, 0, 0
    for res in client.messages.batches.results(batch_id):
        chunk = chunks.get(res.custom_id)
        if res.result.type != 'succeeded' or chunk is None:
            errors += 1
            continue
        msg = res.result.message
        u = msg.usage
        tin += (u.input_tokens or 0) + (u.cache_creation_input_tokens or 0) + (u.cache_read_input_tokens or 0)
        tout += u.output_tokens or 0
        text = next((b.text for b in msg.content if b.type == 'text'), '')
        try:
            genres.update(parse(text, chunk, today, names))
        except ValueError:
            errors += 1
    return genres, tin, tout, errors


def wait(client, batch_id, minutes):
    """True si el lote terminó antes de `minutes`."""
    limit = time.time() + minutes * 60
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        if batch.processing_status == 'ended':
            return True
        if time.time() > limit:
            return False
        print(f'⏳ Lote {batch_id}: {batch.request_counts.processing} tandas en proceso…')
        time.sleep(30)


def pick(titles, genres, sample, limit):
    """Las claves a mandar. Prueba: `sample` títulos de Tu plan en un orden que mezcla canales y géneros
    (por la clave, que es un hash). Diaria: los que no están en el caché, hasta `limit`."""
    plan = sorted(k for k, v in titles.items() if v[2])
    if sample:
        return plan[:sample]
    return [k for k in plan if k not in genres][:limit]


def money(x):
    """Como mt.usd, pero los centavos de una prueba no quedan en «US$ 0,00»."""
    return mt.usd(x) if x >= 0.01 else f'US$ {x:.4f}'.replace('.', ',')


def cost(tin, tout):
    return tin * mt.PRICE_IN + tout * mt.PRICE_OUT


def sample_page(rows):
    """La página de muestras: título, descripción, género, temas y si es en vivo."""
    body = ''.join(
        f'<tr><td><b>{html.escape(t)}</b><small>{html.escape(d[:160])}</small></td><td>{html.escape(g)}</td>'
        f'<td>{html.escape(", ".join(tp))}</td><td>{"en vivo" if v else ""}</td></tr>' for t, d, g, tp, v in rows)
    return f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Muestras de la IA</title><style>
:root{{color-scheme:light dark;--bg:#fff;--fg:#111;--mute:#666;--line:#ddd}}
@media (prefers-color-scheme:dark){{:root{{--bg:#111;--fg:#eee;--mute:#999;--line:#333}}}}
body{{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}}
table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid var(--line);padding:8px;text-align:left;
vertical-align:top}}small{{display:block;color:var(--mute)}}</style></head><body>
<h1>Muestras de la IA</h1><p>{len(rows)} programas clasificados con Claude Haiku 5.5.</p>
<table><tr><th>Programa</th><th>Género</th><th>Temas</th><th></th></tr>{body}</table></body></html>
"""


def summary(rows, spent, pending, sample):
    lines = ['## Clasificar la guía con IA' + (' (prueba)' if sample else ''), '']
    if pending:
        lines.append(f'El lote sigue en proceso: lo recoge la corrida siguiente ({pending} títulos).')
    if spent:
        lines.append(f"{spent['titles']} títulos clasificados · {spent['tokens_in']:,} tokens de entrada y "
                     f"{spent['tokens_out']:,} de salida · **{money(spent['cost'])}**"
                     + (f" · {spent['errors']} tandas con error" if spent['errors'] else ''))
    if rows:
        lines += ['', '| Programa | Género | Temas |', '|---|---|---|']
        lines += [f"| {t.replace('|', '/')} | {g} | {', '.join(tp)}{' · en vivo' if v else ''} |"
                  for t, _, g, tp, v in rows[:60]]
    return '\n'.join(lines) + '\n'


def main(argv=None):
    sample = int(os.environ.get('AI_SAMPLE') or 0)
    if not sample and os.environ.get('AI_CLASSIFY') != 'on':
        print('ℹ️  Clasificación con IA apagada (variable AI_CLASSIFY del repo).')
        return 0
    if not os.environ.get('ANTHROPIC_API_KEY'):
        print('ℹ️  Sin ANTHROPIC_API_KEY: no se clasifica nada.')
        return 0
    if not os.path.isdir(mt.SCHEDULE_DIR):
        print(f'ℹ️  No hay {mt.SCHEDULE_DIR}: nada que clasificar.')
        return 0
    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request
    from auto_sources import load_web, r2_client, read_json

    r2 = r2_client()
    configs = load_web(r2)[0] if r2 else {}
    genres = (read_json(r2, GENRES_KEY) if r2 else None) or {}
    spend = (read_json(r2, SPEND_KEY) if r2 else None) or []
    pending = (read_json(r2, PENDING_KEY) if r2 else None) or None
    titles = mt.collect(mt.SCHEDULE_DIR, mt.used_files(configs) if configs else None)
    names = {k: v[0] for k, v in titles.items()}
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    client = anthropic.Anthropic()
    minutes = float(os.environ.get('AI_WAIT_MIN') or 20)
    got, tin, tout, errors, left = {}, 0, 0, 0, 0

    # Primero, el lote que quedó en proceso en la corrida anterior.
    if pending and wait(client, pending['id'], 0):
        g, i, o, e = collect_batch(client, pending['id'], pending['chunks'], today, names)
        got.update(g)
        tin, tout, errors, pending = tin + i, tout + o, errors + e, None

    keys = [] if pending else pick(titles, genres, sample, int(os.environ.get('AI_MAX_TITLES') or 3000))
    # La prueba vuelve a clasificar sus muestras aunque estén en el caché: sirve para ver un cambio en las instrucciones.
    todo = [k for k in keys if k not in got and (sample or k not in genres)]
    if todo:
        reqs = requests_for(todo, titles)
        batch = client.messages.batches.create(requests=[
            Request(custom_id=cid, params=MessageCreateParamsNonStreaming(**params)) for cid, _, params in reqs])
        chunks = {cid: chunk for cid, chunk, _ in reqs}
        print(f'📤 Lote {batch.id}: {len(todo)} títulos en {len(reqs)} tandas')
        if wait(client, batch.id, minutes):
            g, i, o, e = collect_batch(client, batch.id, chunks, today, names)
            got.update(g)
            tin, tout, errors = tin + i, tout + o, errors + e
        else:
            pending, left = {'id': batch.id, 'chunks': chunks, 'date': today}, len(todo)

    genres.update(got)
    spent = None
    if got or errors:
        spent = {'date': today, 'titles': len(got), 'tokens_in': tin, 'tokens_out': tout,
                 'cost': round(cost(tin, tout), 4), 'errors': errors, 'sample': bool(sample)}
        spend = (spend + [spent])[-mt.HISTORY_DAYS:]
    if r2:
        r2.put(GENRES_KEY, json.dumps(genres, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        r2.put(SPEND_KEY, json.dumps(spend, separators=(',', ':')).encode('utf-8'))
        r2.put(PENDING_KEY, json.dumps(pending).encode('utf-8'))

    rows = [(titles[k][0], titles[k][1], *genres[k][:3]) for k in keys if k in genres]
    if sample and rows:
        os.makedirs(os.path.dirname(SAMPLE_PAGE), exist_ok=True)
        with open(SAMPLE_PAGE, 'w', encoding='utf-8') as f:
            f.write(sample_page(rows))
    text = summary(rows if sample else [], spent, left, sample)
    print(text)
    out = os.environ.get('GITHUB_STEP_SUMMARY')
    if out:
        with open(out, 'a', encoding='utf-8') as f:
            f.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
