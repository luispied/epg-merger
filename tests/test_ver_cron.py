"""tools/ver_cron.py: resumen de las corridas del cron que muestra wrangler tail."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

from ver_cron import eventos, lineas  # noqa: E402


def test_solo_el_cron_con_resultado_y_sin_ids():
    texto = '''ruido
{"outcome": "ok", "event": {"request": {"url": "https://x/secreto"}}, "logs": []}
{
  "outcome": "exceededCpu", "eventTimestamp": 1794261600000, "event": {"cron": "*/30 * * * *"},
  "exceptions": [{"name": "Error", "message": "falló abcdefghijklmnop1234"}],
  "logs": [{"level": "error", "message": ["streamcheck", "abcdefghijklmnop1234", "el relay respondió 502"]}]
}'''
    ls = lineas(eventos(texto))
    assert len(ls) == 3 and 'exceededCpu' in ls[0] and '*/30' in ls[0]
    assert 'abcdefghijklmnop1234' not in '\n'.join(ls) and 'secreto' not in '\n'.join(ls)
    assert 'el relay respondió 502' in ls[2]
