"""Tests de tools/classify_genres.py (sin red, sin R2 y sin llamar a ninguna IA)."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import classify_genres as cg  # noqa: E402


def titles(n):
    return {f'k{i:03}': (f'Programa {i}', 'Una descripción ' * 40 if i % 2 else '', i % 5 != 0) for i in range(n)}


def test_tandas_de_50_con_titulos_numerados_y_descripcion_recortada():
    t = titles(120)
    keys = sorted(t)
    reqs = cg.requests_for(keys, t)
    assert [len(chunk) for _, chunk, _ in reqs] == [50, 50, 20]
    params = reqs[0][2]
    assert params['model'] == 'claude-haiku-5-5'
    assert params['output_config']['format']['schema'] == cg.SCHEMA
    text = params['messages'][0]['content']
    assert text.startswith('1. Programa 0\n2. Programa 1 — Una descripción')
    assert max(len(line) for line in text.splitlines()) < 330


def test_parse_toma_lo_valido_y_recorta_temas():
    chunk = ['a', 'b', 'c']
    text = json.dumps({'items': [
        {'n': 1, 'genero': 'Deportes', 'temas': ['fútbol', ' Peñarol ', 'Nacional', 'clásico'], 'vivo': True},
        {'n': 2, 'genero': 'Inventado', 'temas': [], 'vivo': False},
        {'n': 9, 'genero': 'Serie', 'temas': [], 'vivo': False},
        {'n': 3, 'genero': 'Película', 'temas': ['', 'thriller'], 'vivo': False},
    ]})
    got = cg.parse(text, chunk, '2026-10-11')
    assert got == {'a': ['Deportes', ['fútbol', 'Peñarol', 'Nacional'], True, '2026-10-11'],
                   'c': ['Película', ['thriller'], False, '2026-10-11']}


def test_pick_prueba_y_diaria():
    t = titles(30)
    plan = sorted(k for k, v in t.items() if v[2])
    assert cg.pick(t, {}, 5, 100) == plan[:5]
    cached = {plan[0]: ['Otro', [], False, '2026-10-10']}
    assert cg.pick(t, cached, 0, 3) == plan[1:4]


def test_pagina_de_muestras_escapa_html():
    page = cg.sample_page([('<b>Show</b>', 'desc', 'Serie', ['drama'], True)])
    assert '&lt;b&gt;Show&lt;/b&gt;' in page and 'en vivo' in page and 'prefers-color-scheme' in page


def test_apagado_o_sin_clave_no_hace_nada(monkeypatch, capsys):
    monkeypatch.delenv('AI_SAMPLE', raising=False)
    monkeypatch.delenv('AI_CLASSIFY', raising=False)
    assert cg.main() == 0 and 'apagada' in capsys.readouterr().out
    monkeypatch.setenv('AI_CLASSIFY', 'on')
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    assert cg.main() == 0 and 'Sin ANTHROPIC_API_KEY' in capsys.readouterr().out


def test_temas_sin_el_nombre_del_programa_y_publicidad():
    chunk = ['a', 'b']
    names = {'a': 'Blue Bloods · Cerca de casa', 'b': 'GEN90: crema antiarrugas'}
    text = json.dumps({'items': [
        {'n': 1, 'genero': 'Serie', 'temas': ['Blue  Bloods', 'policial', 'nueva york'], 'vivo': False},
        {'n': 2, 'genero': 'Publicidad', 'temas': ['gen90', 'cosmética'], 'vivo': False},
    ]})
    got = cg.parse(text, chunk, '2026-10-12', names)
    assert got['a'][:2] == ['Serie', ['policial', 'nueva york']]
    assert got['b'][:2] == ['Publicidad', ['cosmética']]
    assert 'Publicidad' in cg.NEVER_SUGGEST and 'Publicidad' in cg.SYSTEM


def test_costo_de_una_prueba_no_queda_en_cero():
    assert cg.money(0.0031) == 'US$ 0,0031'
    assert cg.money(1.2) == 'US$ 1,20'
