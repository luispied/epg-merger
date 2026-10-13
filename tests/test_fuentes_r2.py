"""Tests de tools/fuentes_r2.py: editar y respaldar las fuentes privadas sin tocar nada del repo."""
import os
import stat
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
sys.path.insert(0, os.path.join(ROOT, 'tests'))

import fuentes_r2  # noqa: E402
from fake_s3 import FakeS3  # noqa: E402

ORIGINAL = b'{"sources": [{"id": "a", "url": "https://uno.example/xml"}]}'


def editor_que_escribe(tmp_path, contenido):
    """Un «editor» de mentira: deja el archivo con exactamente `contenido`."""
    fuente = tmp_path / 'contenido.json'
    fuente.write_bytes(contenido)
    script = tmp_path / 'editor.sh'
    script.write_text(f'#!/bin/sh\ncp "{fuente}" "$1"\n')
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return str(script)


def s3_con(nombre, cuerpo):
    s3 = FakeS3()
    s3.objects[fuentes_r2.PREFIJO + nombre] = (cuerpo, {})
    return s3


def test_validar_acepta_sources_y_urls_y_rechaza_lo_demas():
    assert fuentes_r2.validar('{"sources": []}') == {'sources': []}
    assert fuentes_r2.validar('{"urls": ["https://x.example"]}') == {'urls': ['https://x.example']}
    with pytest.raises(ValueError):
        fuentes_r2.validar('{"otra": 1}')
    with pytest.raises(ValueError):
        fuentes_r2.validar('no es json')


def test_editar_sube_el_cambio_y_guarda_el_respaldo(tmp_path):
    nuevo = b'{"sources": [{"id": "b", "url": "https://dos.example/xml"}]}'
    s3 = s3_con('epg_urls.json', ORIGINAL)
    clave = fuentes_r2.editar('epg_urls.json', s3=s3, editor=editor_que_escribe(tmp_path, nuevo))
    assert s3.objects[fuentes_r2.PREFIJO + 'epg_urls.json'][0] == nuevo
    assert s3.objects[clave][0] == ORIGINAL
    assert clave.startswith(fuentes_r2.BACKUP) and clave.endswith('/epg_urls.json')


def test_editar_sin_cambios_no_sube_nada(tmp_path):
    s3 = s3_con('epg_urls.json', ORIGINAL)
    assert fuentes_r2.editar('epg_urls.json', s3=s3, editor=editor_que_escribe(tmp_path, ORIGINAL)) is None
    assert s3.puts == []


def test_editar_no_sube_un_json_invalido(tmp_path):
    s3 = s3_con('epg_urls.json', ORIGINAL)
    with pytest.raises(SystemExit, match='JSON inválido'):
        fuentes_r2.editar('epg_urls.json', s3=s3, editor=editor_que_escribe(tmp_path, b'{"roto": '))
    assert s3.puts == []


def test_editar_no_inventa_un_archivo_que_no_esta_en_r2(tmp_path):
    with pytest.raises(SystemExit, match='no está en R2'):
        fuentes_r2.editar('epg_urls.json', s3=FakeS3(), editor=editor_que_escribe(tmp_path, ORIGINAL))


def test_solo_edita_los_archivos_de_fuentes():
    with pytest.raises(SystemExit, match='no es un archivo de fuentes'):
        fuentes_r2.editar('merge_epgs.py', s3=FakeS3())


def test_respaldo_sin_nada_en_r2_no_hace_nada():
    assert fuentes_r2.respaldo(FakeS3(), 'epg_urls.json', '2026-10-13T000000Z') is None
