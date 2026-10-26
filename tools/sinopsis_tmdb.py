#!/usr/bin/env python3
"""Trae sinopsis en español de TMDB para las películas y series de la guía, y las guarda en R2.

Lee la guía publicada (`merged.xml.gz`), toma los títulos de películas y series y busca cada uno en TMDB
(`search/multi`, español). Un título vale si TMDB tiene uno igual (nombre normalizado) con sinopsis no vacía.
El resultado es un solo JSON `desc/tmdb.json` en R2: {título normalizado: {"n": nombre, "s": sinopsis,
"id": id, "k": movie|tv}}. La app lo lee en la hoja del programa; nunca se consulta TMDB en vivo.

Es acumulativo: lo que ya está en R2 no se vuelve a buscar, así que cada corrida avanza hasta `--max`
búsquedas nuevas. Los títulos sin coincidencia se guardan vacíos (`null`) para no repetirlos.

Uso: `python tools/sinopsis_tmdb.py --xmltv merged.xml.gz [--max 3000] [--local out.json]`.
Sin `--local` sube a R2 con las mismas variables que el resto de las herramientas (R2_ACCOUNT_ID, ...).
"""
import argparse
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
KEY = 'desc/tmdb.json'
UA = {'User-Agent': 'nowline-sinopsis/1.0'}


def normalizar(texto):
    sin_tildes = unicodedata.normalize('NFKD', texto or '').encode('ascii', 'ignore').decode()
    limpio = re.sub(r'[^a-z0-9 ]+', ' ', sin_tildes.lower())
    return re.sub(r'\s+', ' ', limpio).strip()


def titulos_de_peliculas(ruta):
    """Títulos normalizados de películas y series, con el título tal como viene en la guía."""
    vistos = {}
    abre = gzip.open if ruta.endswith('.gz') else open
    with abre(ruta, 'rb') as f:
        for _, el in ElementTree.iterparse(f, events=('end',)):
            if el.tag == 'programme':
                titulo = (el.findtext('title') or '').strip()
                cats = [(c.text or '').strip() for c in el.findall('category')]
                if titulo and any(MOVIE_CAT_RE.search(c) for c in cats):
                    vistos.setdefault(normalizar(titulo), titulo)
                el.clear()
    return vistos


def buscar(titulo, clave):
    """Devuelve la entrada para el título, o None si TMDB no tiene una coincidencia con sinopsis."""
    q = urllib.parse.urlencode({'api_key': clave, 'language': 'es-ES', 'query': titulo})
    req = urllib.request.Request(f'https://api.themoviedb.org/3/search/multi?{q}', headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        datos = json.loads(r.read().decode('utf-8'))
    for r in datos.get('results') or []:
        if r.get('media_type') not in ('movie', 'tv'):
            continue
        nombre = r.get('title') or r.get('name') or ''
        sinopsis = (r.get('overview') or '').strip()
        if normalizar(nombre) == normalizar(titulo) and sinopsis:
            return {'n': nombre, 's': sinopsis, 'id': r.get('id'), 'k': r['media_type']}
    return None


def cargar_r2():
    import boto3  # importado acá: en local no hace falta
    cliente = boto3.client(
        's3', endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
        region_name='auto')
    return cliente, os.environ.get('R2_BUCKET') or 'grilla'


def leer_existente(cliente, bucket):
    try:
        obj = cliente.get_object(Bucket=bucket, Key=KEY)
    except cliente.exceptions.NoSuchKey:
        return {}
    return json.loads(obj['Body'].read().decode('utf-8'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xmltv', required=True)
    ap.add_argument('--max', type=int, default=3000, help='búsquedas nuevas por corrida')
    ap.add_argument('--espera', type=float, default=0.3)
    ap.add_argument('--local', help='guardar en un archivo en vez de subir a R2')
    args = ap.parse_args()

    clave = os.environ.get('TMDB_API_KEY', '').strip()
    if not clave:
        print('Sin TMDB_API_KEY: no se busca nada.', file=sys.stderr)
        return 1

    titulos = titulos_de_peliculas(args.xmltv)
    cliente = bucket = None
    if args.local:
        existente = {}
        if os.path.exists(args.local):
            with open(args.local, encoding='utf-8') as f:
                existente = json.load(f)
    else:
        cliente, bucket = cargar_r2()
        existente = leer_existente(cliente, bucket)

    nuevos = [n for n in titulos if n not in existente]
    print(f'Títulos en la guía: {len(titulos)}. Ya guardados: {len(titulos) - len(nuevos)}. '
          f'Por buscar esta corrida: {min(len(nuevos), args.max)}.')

    busquedas = encontradas = 0
    for norm in nuevos[:args.max]:
        try:
            entrada = buscar(titulos[norm], clave)
        except Exception as e:  # noqa: BLE001 - un título que falla no corta la corrida
            print(f'Error con «{titulos[norm]}»: {e}', file=sys.stderr)
            continue
        existente[norm] = entrada
        encontradas += entrada is not None
        busquedas += 1
        time.sleep(args.espera)

    if args.local:
        with open(args.local, 'w', encoding='utf-8') as f:
            json.dump(existente, f, ensure_ascii=False)
    else:
        cuerpo = json.dumps(existente, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        cliente.put_object(Bucket=bucket, Key=KEY, Body=cuerpo, ContentType='application/json')

    con_sinopsis = sum(1 for v in existente.values() if v)
    print(f'Búsquedas: {busquedas}. Con sinopsis nuevas: {encontradas}. Total con sinopsis: {con_sinopsis} '
          f'de {len(existente)} títulos guardados.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
