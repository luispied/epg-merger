"""tools/resumen_medicion.py: cantidades de la medición de canales."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

from resumen_medicion import resumen  # noqa: E402


def test_cuenta_resolucion_fps_y_lo_medido_desde_el_pedido():
    health = {
        'attempted': '2026-11-09T01:00:00Z',
        'channels': {'a': {'ok': True}, 'b': {'ok': True}, 'c': {'ok': False}, 'd': {'ok': True}},
        'res': {
            'a': {'t': '2026-11-09T01:00:00Z', 'w': 1920, 'h': 1080, 'f': 50, 'v': 2},
            'b': {'t': '2026-11-09T01:00:00Z', 'w': 1280, 'h': 720, 'v': 2},
            'c': {'t': '2026-11-08T10:00:00Z', 'w': 1280, 'h': 720},
            'd': {'t': '2026-11-09T01:00:00Z'},
        },
    }
    r = resumen(health, {'at': '2026-11-09T00:12:00Z', 'remedir': True})
    assert (r['con_resolucion'], r['sin_resolucion'], r['con_fps'], r['caidos']) == (3, 1, 1, 1)
    assert (r['medidos_desde_el_pedido'], r['medidos_antes_del_pedido']) == (3, 1)
    assert r['version_2'] == 2
    assert r['fps'] == {50: 1}
    assert r['pedido_remedir'] is True


def test_sin_remedir_no_cuenta_antes_ni_despues_y_sin_datos_no_falla():
    r = resumen({'res': {'a': {'t': '2026-11-09T01:00:00Z', 'w': 1, 'h': 2}}}, {'at': '2026-11-09T00:12:00Z'})
    assert (r['medidos_desde_el_pedido'], r['medidos_antes_del_pedido'], r['pedido_remedir']) == (0, 0, False)
    assert resumen(None, None)['con_resolucion'] == 0


def test_muestra_la_prueba_a_medias_y_cuando_se_guardo():
    r = resumen({'tested': 12}, None, {'started': 'a', 'at': 'b', 'done': 50, 'total': 400, 'down': 1, 'otro': 9}, 'c')
    assert r['prueba_a_medias'] == {'started': 'a', 'at': 'b', 'done': 50, 'total': 400, 'down': 1}
    assert (r['health_guardado'], r['probados_en_la_ultima']) == ('c', 12)
    assert resumen({}, None)['prueba_a_medias'] is None
