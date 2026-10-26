#!/usr/bin/env python3
"""Cuenta los títulos de películas y series de los canales visibles de las configuraciones con guía.

Un canal cuenta si: está en la lista de una configuración (list/<id>.json), no está oculto (ni su grupo), y tiene
guía asignada (la de cfg.channels o la de la lista). Con eso arma el conjunto de guías (epg) visibles en todas las
configuraciones y cuenta, en merged.xml.gz, los títulos de películas y series de esos canales. Solo cuenta: no busca
en TMDB. Sirve para decidir cuántas tandas de sinopsis_tmdb.py hacen falta.

Uso: `python tools/titulos_visibles.py --xmltv merged.xml.gz` (con las variables R2_* para leer R2).
"""
import argparse
import gzip
import json
import sys
from xml.etree import ElementTree


def leer_json(cliente, bucket, clave):
    try:
        obj = cliente.get_object(Bucket=bucket, Key=clave)
    except cliente.exceptions.NoSuchKey:
        return None
    return json.loads(obj['Body'].read().decode('utf-8'))


def epgs_visibles(cliente, bucket):
    """Guías (epg) de los canales visibles con guía, de todas las configuraciones."""
    epgs = set()
    configs = 0
    paginas = cliente.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='cfg/')
    for pagina in paginas:
        for obj in pagina.get('Contents', []):
            clave = obj['Key']
            if not clave.endswith('.json'):
                continue
            cfg_id = clave[len('cfg/'):-len('.json')]
            cfg = leer_json(cliente, bucket, clave) or {}
            lista = leer_json(cliente, bucket, f'list/{cfg_id}.json')
            if not lista:
                continue
            configs += 1
            ediciones = cfg.get('channels') or {}
            grupos_ocultos = set((cfg.get('groups') or {}).get('hidden') or [])
            for ch in lista.get('channels') or []:
                edit = ediciones.get(ch.get('name'), {})
                grupo = edit.get('group') or ch.get('category')
                if edit.get('hidden') or grupo in grupos_ocultos:
                    continue
                epg = edit.get('epg') or ch.get('epg')
                if epg:
                    epgs.add(epg)
    return epgs, configs


def titulos_de(ruta, epgs):
    """Títulos normalizados de películas y series de los canales con esas guías, y el total de la guía."""
    from sinopsis_tmdb import MOVIE_CAT_RE, normalizar  # importado acá: sinopsis_tmdb importa este archivo
    vistos = {}
    total = 0
    abre = gzip.open if ruta.endswith('.gz') else open
    with abre(ruta, 'rb') as f:
        for _, el in ElementTree.iterparse(f, events=('end',)):
            if el.tag == 'programme':
                titulo = (el.findtext('title') or '').strip()
                cats = [(c.text or '').strip() for c in el.findall('category')]
                if titulo and any(MOVIE_CAT_RE.search(c) for c in cats):
                    total += 1
                    if el.get('channel') in epgs:
                        vistos.setdefault(normalizar(titulo), titulo)
                el.clear()
    return vistos, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xmltv', required=True)
    args = ap.parse_args()

    from sinopsis_tmdb import KEY, cargar_r2  # importado acá: sinopsis_tmdb importa este archivo

    cliente, bucket = cargar_r2()
    epgs, configs = epgs_visibles(cliente, bucket)
    existente = leer_json(cliente, bucket, KEY) or {}
    titulos, total = titulos_de(args.xmltv, epgs)
    nuevos = [n for n in titulos if n not in existente]
    print(f'Configuraciones: {configs}. Guías de canales visibles: {len(epgs)}.')
    print(f'Títulos de películas y series en esos canales: {len(titulos)} (de {total} emisiones).')
    print(f'Ya guardados: {len(titulos) - len(nuevos)}. Por buscar: {len(nuevos)}. '
          f'Tandas de 3000: {-(-len(nuevos) // 3000)}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
