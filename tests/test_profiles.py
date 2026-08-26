"""Tests de la carga de perfiles."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from profiles import load_profiles


def test_variables_sueltas_como_perfil_default():
    """Compatibilidad: la configuración de siempre sigue funcionando sin migrar nada."""
    p = load_profiles({'XTREAM_USERNAME': 'u', 'XTREAM_PASSWORD': 'p',
                       'XTREAM_SERVERS': 'http://a:8080, http://b:8080/'})
    assert len(p) == 1
    assert p[0]['name'] == 'default'
    assert p[0]['servers'] == ['http://a:8080', 'http://b:8080']


def test_sin_configuracion_no_hay_perfiles():
    assert load_profiles({}) == []
    assert load_profiles({'XTREAM_USERNAME': 'u'}) == []


def test_varios_perfiles_desde_el_secret_json():
    p = load_profiles({'XTREAM_PROFILES': '''[
        {"name": "luis", "servers": ["http://a:8080"], "username": "u1", "password": "p1", "gist_id": "g1"},
        {"name": "juan", "servers": ["http://a:8080"], "username": "u2", "password": "p2"}
    ]'''})
    assert [x['name'] for x in p] == ['luis', 'juan']
    assert p[0]['gist_id'] == 'g1'
    assert p[1]['gist_id'] is None


def test_el_secret_tiene_prioridad_sobre_las_variables_sueltas():
    p = load_profiles({
        'XTREAM_PROFILES': '[{"name":"a","servers":["http://x"],"username":"u","password":"p"}]',
        'XTREAM_USERNAME': 'viejo', 'XTREAM_PASSWORD': 'v', 'XTREAM_SERVERS': 'http://y',
    })
    assert [x['name'] for x in p] == ['a']


def test_perfiles_invalidos_se_saltean_sin_romper_el_resto(capsys):
    p = load_profiles({'XTREAM_PROFILES': '''[
        {"name": "ok", "servers": ["http://a"], "username": "u", "password": "p"},
        {"name": "sin-pass", "servers": ["http://a"], "username": "u"},
        {"name": "nombre/malo", "servers": ["http://a"], "username": "u", "password": "p"},
        {"name": "ok", "servers": ["http://a"], "username": "u", "password": "p"}
    ]'''})
    assert [x['name'] for x in p] == ['ok']
    salida = capsys.readouterr().out
    assert 'sin-pass' in salida and 'nombre/malo' in salida
    assert 'p' not in salida.split('sin-pass')[1][:5], "no se filtran credenciales al log"


def test_json_invalido_no_genera_nada(capsys):
    assert load_profiles({'XTREAM_PROFILES': '{roto'}) == []
    assert 'válido' in capsys.readouterr().out


def test_gist_id_en_el_perfil_default():
    """Con un solo usuario no hace falta migrar a XTREAM_PROFILES para publicar en un gist."""
    p = load_profiles({'XTREAM_USERNAME': 'u', 'XTREAM_PASSWORD': 'p',
                       'XTREAM_SERVERS': 'http://a', 'XTREAM_GIST_ID': 'abc123'})
    assert p[0]['gist_id'] == 'abc123'
