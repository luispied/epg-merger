#!/usr/bin/env python3
"""Mide, sin IA y sin costo, cuántos títulos de la guía cruzan con una API pública de descripciones.

- **Deportes** (`A vs B`): TheSportsDB (`searchevents.php`, clave de prueba pública «3») y, si hay
  `FOOTBALL_DATA_TOKEN`, football-data.org (partidos por día de las 12 competiciones gratis).
- **Películas y series**: TMDB (`search/multi`, español) con `TMDB_API_KEY`.

Toma la muestra de `merged.xml.gz` (la guía publicada). Un cruce es bueno si el título encontrado
coincide con el de la guía (nombre normalizado) y la API trae una sinopsis no vacía. Deja el
resultado en `--json` y un resumen en markdown (`--md`, o el resumen de la corrida de GitHub).

Uso: `python tools/medir_descripciones.py --xmltv merged.xml.gz --json out.json --md out.md`.
Las claves se leen del entorno; sin clave, esa parte se saltea y queda anotada en el resultado.
"""
import argparse
import datetime
import difflib
import gzip
import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from xml.etree import ElementTree

SPORTS_RE = re.compile(r'^\s*(.+?)\s+(?:vs\.?|v)\s+(.+?)\s*$', re.I)
MOVIE_CAT_RE = re.compile(r'movie|film|pel[ií]cula|series|serie|telenovela|drama', re.I)
TSDB_KEY = '3'  # clave pública de prueba de TheSportsDB
UA = {'User-Agent': 'nowline-medicion/1.0'}


def normalizar(texto):
    sin_tildes = unicodedata.normalize('NFKD', texto or '').encode('ascii', 'ignore').decode()
    limpio = re.sub(r'[^a-z0-9 ]+', ' ', sin_tildes.lower())
    return re.sub(r'\s+', ' ', limpio).strip()


def pedir(url, headers=None, espera=0.0):
    if espera:
        time.sleep(espera)
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


def leer_programas(ruta, limite_por_tipo):
    """Devuelve (deportes, peliculas): títulos distintos con su primera fecha y canal."""
    deportes, peliculas = {}, {}
    abre = gzip.open if ruta.endswith('.gz') else open
    with abre(ruta, 'rb') as f:
        for _, el in ElementTree.iterparse(f, events=('end',)):
            if el.tag != 'programme':
                continue
            titulo = (el.findtext('title') or '').strip()
            cats = [(c.text or '').strip() for c in el.findall('category')]
            inicio = el.get('start', '')[:8]
            canal = el.get('channel', '')
            if SPORTS_RE.match(titulo):
                deportes.setdefault(normalizar(titulo), (titulo, inicio, canal))
            elif any(MOVIE_CAT_RE.search(c) for c in cats):
                peliculas.setdefault(normalizar(titulo), (titulo, inicio, canal))
            el.clear()
    return (
        list(deportes.values())[:limite_por_tipo],
        list(peliculas.values())[:limite_por_tipo],
    )


def cruza_nombre(a, b):
    a, b = normalizar(a), normalizar(b)
    if not a or not b:
        return False
    return a == b or a in b or b in a or difflib.SequenceMatcher(None, a, b).ratio() >= 0.85


def medir_thesportsdb(titulo):
    m = SPORTS_RE.match(titulo)
    local, visita = m.group(1), m.group(2)
    q = urllib.parse.quote(f'{local}_vs_{visita}')
    datos = pedir(f'https://www.thesportsdb.com/api/v1/json/{TSDB_KEY}/searchevents.php?e={q}', espera=1.5)
    for ev in (datos or {}).get('event') or []:
        if cruza_nombre(local, ev.get('strHomeTeam')) and cruza_nombre(visita, ev.get('strAwayTeam')):
            desc = (ev.get('strDescriptionEN') or '').strip()
            return {'ok': True, 'con_texto': bool(desc), 'fuente': 'thesportsdb', 'evento': ev.get('strEvent')}
    return {'ok': False, 'fuente': 'thesportsdb'}


def medir_football_data(muestras, token):
    """Partidos por día (un pedido por fecha, límite gratis de 10 por minuto)."""
    fechas = sorted({inicio for _, inicio, _ in muestras if inicio})
    resultado = {}
    for dia in fechas:
        d = f'{dia[:4]}-{dia[4:6]}-{dia[6:8]}'
        try:
            datos = pedir(f'https://api.football-data.org/v4/matches?dateFrom={d}&dateTo={d}',
                          headers={'X-Auth-Token': token}, espera=6.5)
        except Exception as e:  # noqa: BLE001 - se anota y se sigue con el resto
            resultado[d] = {'error': str(e)}
            continue
        resultado[d] = datos.get('matches') or []
    return resultado


def cruce_football_data(titulo, inicio, partidos_por_dia):
    m = SPORTS_RE.match(titulo)
    d = f'{inicio[:4]}-{inicio[4:6]}-{inicio[6:8]}'
    for p in partidos_por_dia.get(d) or []:
        if not isinstance(p, dict):
            continue
        local = p.get('homeTeam', {}).get('name', '')
        visita = p.get('awayTeam', {}).get('name', '')
        if cruza_nombre(m.group(1), local) and cruza_nombre(m.group(2), visita):
            return {'ok': True, 'con_texto': False, 'fuente': 'football-data', 'evento': f'{local} vs {visita}'}
    return {'ok': False, 'fuente': 'football-data'}


def medir_tmdb(titulo, clave):
    q = urllib.parse.urlencode({'api_key': clave, 'language': 'es-ES', 'query': titulo})
    datos = pedir(f'https://api.themoviedb.org/3/search/multi?{q}', espera=0.3)
    resultados = [r for r in (datos.get('results') or []) if r.get('media_type') in ('movie', 'tv')]
    for r in resultados:
        nombre = r.get('title') or r.get('name') or ''
        if normalizar(nombre) == normalizar(titulo):
            return {'ok': True, 'con_texto': bool((r.get('overview') or '').strip()),
                    'fuente': 'tmdb', 'evento': nombre}
    return {'ok': False, 'fuente': 'tmdb', 'algo_parecido': bool(resultados)}


def resumen(filas):
    total = len(filas)
    cruzan = sum(1 for f in filas if f['resultado'].get('ok'))
    con_texto = sum(1 for f in filas if f['resultado'].get('con_texto'))
    return {'total': total, 'cruzan': cruzan, 'con_texto': con_texto,
            'pct_cruzan': round(100 * cruzan / total, 1) if total else 0.0}


def markdown(informe):
    lineas = ['# Medición de descripciones externas', '',
              f"Fecha: {informe['fecha']}", '',
              '| Grupo | Fuente | Muestra | Cruzan | % | Con sinopsis |',
              '|---|---|---:|---:|---:|---:|']
    for fila in informe['tablas']:
        lineas.append(f"| {fila['grupo']} | {fila['fuente']} | {fila['total']} | {fila['cruzan']} | "
                      f"{fila['pct_cruzan']} | {fila['con_texto']} |")
    for nota in informe['notas']:
        lineas += ['', f'- {nota}']
    return '\n'.join(lineas) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xmltv', required=True)
    ap.add_argument('--muestra', type=int, default=150, help='títulos por grupo')
    ap.add_argument('--json', help='donde guardar el informe')
    ap.add_argument('--md', help='donde guardar el resumen en markdown')
    args = ap.parse_args()

    deportes, peliculas = leer_programas(args.xmltv, args.muestra)
    notas = [f'Muestra: {len(deportes)} títulos «A vs B» y {len(peliculas)} películas o series, '
             'tomados de la guía publicada.']
    filas = {'deportes': [], 'peliculas': []}
    tablas = []

    token_fd = os.environ.get('FOOTBALL_DATA_TOKEN', '').strip()
    clave_tmdb = os.environ.get('TMDB_API_KEY', '').strip()

    for titulo, inicio, canal in deportes:
        try:
            r = medir_thesportsdb(titulo)
        except Exception as e:  # noqa: BLE001
            r = {'ok': False, 'fuente': 'thesportsdb', 'error': str(e)}
        filas['deportes'].append({'titulo': titulo, 'canal': canal, 'resultado': r})

    tablas.append({'grupo': 'Deportes', 'fuente': 'TheSportsDB', **resumen(
        [{'resultado': f['resultado']} for f in filas['deportes']])})

    if token_fd:
        por_dia = medir_football_data(deportes, token_fd)
        for f, (titulo, inicio, canal) in zip(filas['deportes'], deportes):
            f['fd'] = cruce_football_data(titulo, inicio, por_dia)
        tablas.append({'grupo': 'Deportes', 'fuente': 'football-data.org', **resumen(
            [{'resultado': f['fd']} for f in filas['deportes']])})
    else:
        notas.append('football-data.org: sin FOOTBALL_DATA_TOKEN, no se midió.')

    if clave_tmdb:
        for titulo, inicio, canal in peliculas:
            try:
                r = medir_tmdb(titulo, clave_tmdb)
            except Exception as e:  # noqa: BLE001
                r = {'ok': False, 'fuente': 'tmdb', 'error': str(e)}
            filas['peliculas'].append({'titulo': titulo, 'canal': canal, 'resultado': r})
        tablas.append({'grupo': 'Películas y series', 'fuente': 'TMDB (es)', **resumen(
            [{'resultado': f['resultado']} for f in filas['peliculas']])})
    else:
        notas.append('TMDB: sin TMDB_API_KEY, no se midió.')

    informe = {'fecha': datetime.date.today().isoformat(), 'tablas': tablas, 'notas': notas,
               'filas': filas}
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(informe, f, ensure_ascii=False, indent=1)
    texto = markdown(informe)
    if args.md:
        with open(args.md, 'w', encoding='utf-8') as f:
            f.write(texto)
    print(texto)
    return 0


if __name__ == '__main__':
    sys.exit(main())
