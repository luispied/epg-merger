"""Tests de tools/fuentes_r2.py: editar valida y guarda copia antes de subir; restaurar vuelve la copia."""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.path.insert(0, os.path.join(ROOT, 'tests'))

import fuentes_r2  # noqa: E402
from fake_s3 import FakeS3  # noqa: E402

ORIGINAL = json.dumps({'sources': [{'id': 'a', 'url': 'https://fuente.test/a.xml.gz'}]}).encode()


def _editor(tmp_path, contenido):
    """Un «editor» que reemplaza el archivo por `contenido` (bytes), como si Luis lo hubiera editado."""
    script = tmp_path / 'editor.py'
    script.write_bytes(b'import sys\nopen(sys.argv[1], "wb").write(' + repr(contenido).encode() + b')\n')
    return f'{sys.executable} {script}'


def _s3():
    s3 = FakeS3()
    s3.objects['fuentes/epg_urls.json'] = (ORIGINAL, {})
    return s3


def test_editar_valida_guarda_copia_y_sube(tmp_path):
    s3 = _s3()
    nuevo = json.dumps({'sources': [{'id': 'b', 'url': 'https://fuente.test/b.xml.gz'}]}).encode()
    assert fuentes_r2.editar('epg_urls.json', s3=s3, editor=_editor(tmp_path, nuevo)) is True
    assert s3.objects['fuentes/epg_urls.json'][0] == nuevo
    copias = [k for k in s3.objects if k.startswith('fuentes/backup/') and k.endswith('/epg_urls.json')]
    assert len(copias) == 1 and s3.objects[copias[0]][0] == ORIGINAL


def test_editar_sin_cambios_no_sube(tmp_path):
    s3 = _s3()
    assert fuentes_r2.editar('epg_urls.json', s3=s3, editor=_editor(tmp_path, ORIGINAL)) is False
    assert s3.puts == [] and not any(k.startswith('fuentes/backup/') for k in s3.objects)


def test_editar_invalido_no_sube_ni_toca_r2(tmp_path):
    s3 = _s3()
    assert fuentes_r2.editar('epg_urls.json', s3=s3, editor=_editor(tmp_path, b'{"sources": 3}')) is False
    assert s3.objects['fuentes/epg_urls.json'][0] == ORIGINAL and s3.puts == []


def test_editar_rechaza_nombres_fuera_de_la_lista(tmp_path):
    try:
        fuentes_r2.editar('otro.json', s3=_s3(), editor='true')
    except SystemExit as e:
        assert 'no es un archivo de fuentes' in str(e)
    else:
        raise AssertionError('debía rechazar el nombre')


def test_restaurar_vuelve_la_copia(tmp_path):
    s3 = _s3()
    s3.objects['fuentes/backup/2026-10-13-120000/epg_urls.json'] = (b'{"sources": []}', {})
    fuentes_r2.restaurar('epg_urls.json', '2026-10-13-120000', s3=s3)
    assert s3.objects['fuentes/epg_urls.json'][0] == b'{"sources": []}'
    previas = [k for k in s3.objects if k.startswith('fuentes/backup/') and s3.objects[k][0] == ORIGINAL]
    assert len(previas) == 1  # la versión que se reemplazó no se pierde
