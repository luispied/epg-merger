#!/usr/bin/env python3
"""Mide, sin IA y sin costo, cuántos títulos de películas y series de la guía cruzan con TMDB.

Usa TMDB en español (`search/multi`) con `TMDB_API_KEY`. Toma la muestra de `merged.xml.gz` (la guía
publicada). Un cruce es bueno si el título encontrado coincide con el de la guía (nombre normalizado)
y TMDB trae una sinopsis no vacía. Deja el resultado en `--json` y un resumen en markdown (`--md`, o el
resumen de la corrida de GitHub).

Uso: `python tools/medir_descripciones.py --xmltv merged.xml.gz --json out.json --md out.md`.
Sin `TMDB_API_KEY` no mide nada y lo anota en el resultado.
"""
import argparse
import datetime
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

MOVIE_CAT_RE = re.compile(r'movie|film|pel[ií]cula|series|serie|telenovela|drama', re.I)
UA = {'User-Agent': 'nowline-medicion/1.0'}


def normalizar(texto):
    sin_tildes = unicodedata.normalize('NFKD', texto or '').encode('ascii', 'ignore').decode()
    limpio = re.sub(r'[^a-z0-9 ]+', ' ', sin_tildes.lower())
    return re.sub(r'\s+', ' ', limpio).strip()


def pedir(url, espera=0.0):
    if espera:
        time.sleep(espera)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


def leer_peliculas(ruta, limite):
    """Títulos distintos de películas y series, con su primera fecha y canal."""
    peliculas = {}
    abre = gzip.open if ruta.endswith('.gz') else open
    with abre(ruta, 'rb') as f:
        for _, el in ElementTree.iterparse(f, events=('end',)):
            if el.tag != 'programme':
                continue
            titulo = (el.findtext('title') or '').strip()
            cats = [(c.text or '').strip() for c in el.findall('category')]
            if any(MOVIE_CAT_RE.search(c) for c in cats):
                peliculas.setdefault(normalizar(titulo), (titulo, el.get('start', '')[:8], el.get('channel', '')))
            el.clear()
    return list(peliculas.values())[:limite]


def medir_tmdb(titulo, clave):
    q = urllib.parse.urlencode({'api_key': clave, 'language': 'es-ES', 'query': titulo})
    datos = pedir(f'https://api.themoviedb.org/3/search/multi?{q}', espera=0.3)
    resultados = [r for r in (datos.get('results') or []) if r.get('media_type') in ('movie', 'tv')]
    for r in resultados:
        nombre = r.get('title') or r.get('name') or ''
        if normalizar(nombre) == normalizar(titulo):
            return {'ok': True, 'con_texto': bool((r.get('overview') or '').strip()), 'evento': nombre}
    return {'ok': False, 'algo_parecido': bool(resultados)}


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
    ap.add_argument('--muestra', type=int, default=150, help='títulos de la muestra')
    ap.add_argument('--json', help='donde guardar el informe')
    ap.add_argument('--md', help='donde guardar el resumen en markdown')
    args = ap.parse_args()

    peliculas = leer_peliculas(args.xmltv, args.muestra)
    notas = [f'Muestra: {len(peliculas)} películas o series, tomadas de la guía publicada.']
    clave = os.environ.get('TMDB_API_KEY', '').strip()
    filas = []
    tablas = []

    if clave:
        for titulo, inicio, canal in peliculas:
            try:
                r = medir_tmdb(titulo, clave)
            except Exception as e:  # noqa: BLE001 - se anota y se sigue con el resto
                r = {'ok': False, 'error': str(e)}
            filas.append({'titulo': titulo, 'canal': canal, 'resultado': r})
        tablas.append({'grupo': 'Películas y series', 'fuente': 'TMDB (es)', **resumen(filas)})
    else:
        notas.append('TMDB: sin TMDB_API_KEY, no se midió.')

    informe = {'fecha': datetime.date.today().isoformat(), 'tablas': tablas, 'notas': notas, 'filas': filas}
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
