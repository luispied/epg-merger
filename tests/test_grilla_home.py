"""tools/grilla_home.py: subir la lista desde un equipo de la casa."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import grilla_home as gh  # noqa: E402

ENV = {'GRILLA_CFG': 'cfg123', 'GRILLA_KEY': 'clave', 'XTREAM_SERVERS': 'http://a:80, http://b',
       'XTREAM_USERNAME': 'u', 'XTREAM_PASSWORD': 'p'}


def test_lee_el_archivo_y_valida(tmp_path):
    f = tmp_path / 'g.env'
    f.write_text('# datos\nGRILLA_CFG=cfg123\nGRILLA_KEY="clave"\n', encoding='utf-8')
    assert gh.read_env_file(str(f)) == {'GRILLA_CFG': 'cfg123', 'GRILLA_KEY': 'clave'}
    s = gh.settings(ENV)
    assert s['servers'] == ['http://a:80', 'http://b'] and s['worker'] == gh.DEFAULT_WORKER
    with pytest.raises(ValueError):
        gh.settings({'GRILLA_CFG': 'x'})


def test_sube_solo_la_lista_sin_credenciales():
    sent = {}

    class Res:
        status_code = 200

        @staticmethod
        def json():
            return {'channels': 1}

    class Session:
        @staticmethod
        def put(url, timeout, headers, data):
            sent.update(url=url, headers=headers, body=data.decode('utf-8'))
            return Res()

    s = gh.settings(ENV)
    assert gh.upload(s, [{'name': 'A', 'category': 'C', 'id': '1', 'ext': 'ts', 'icon': '', 'epgId': None}], Session) == 1
    assert sent['url'].endswith('/api/cfg/cfg123/list') and sent['headers']['Authorization'] == 'Bearer clave'
    assert 'p' not in json.loads(sent['body'])['channels'][0].values() and 'http://a' not in sent['body']
