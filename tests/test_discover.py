"""Tests de tools/discover_epg_sources.py (sin red: HTTP simulado)."""
import datetime
import gzip
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import discover_epg_sources as d  # noqa: E402

NOW = datetime.datetime(2026, 9, 28, 12, 0, tzinfo=datetime.timezone.utc)


def _xmltv(start, stop):
    return f'''<?xml version="1.0"?><tv>
<channel id="A.ar"><display-name>A</display-name></channel>
<channel id="B.ar"><display-name>B</display-name></channel>
<programme channel="A.ar" start="{start} +0000" stop="{stop} +0000"><title>x</title></programme>
</tv>'''.encode()


def test_candidatos_de_epgshare_desde_el_indice():
    html = ('<a href="epg_ripper_AR1.xml.gz">x</a> <a href="epg_ripper_BEIN1.xml.gz">x</a> '
            '<a href="epg_ripper_US_LOCALS1.xml.gz">x</a> <a href="epg_ripper_ALL_SOURCES1.xml.gz">x</a>'
            '<a href="epg_ripper_UK1.xml.gz">x</a>')
    cands = {c['id']: c for c in d.epgshare_candidates(html)}
    assert set(cands) == {'epgshare-ar1', 'epgshare-bein1', 'epgshare-us_locals1', 'epgshare-uk1'}
    assert cands['epgshare-ar1']['country'] == 'ar'
    assert cands['epgshare-bein1']['country'] is None, "temático: sin país"
    assert cands['epgshare-us_locals1']['country'] == 'us'
    assert cands['epgshare-ar1']['url'].endswith('/epg_ripper_AR1.xml.gz')


def test_evaluar_fresca_y_vieja():
    fresh = d.evaluate_xmltv(io.BytesIO(_xmltv('20260928110000', '20260928130000')), NOW)
    assert fresh == {'channels': 2, 'programmes': 1, 'live_channels': 1, 'last_programme': '20260928110000'}
    stale = d.evaluate_xmltv(io.BytesIO(_xmltv('20251213040000', '20251213050000')), NOW)
    assert stale['live_channels'] == 0 and stale['channels'] == 2


class _Resp:
    def __init__(self, body, status=200):
        self.body, self.status_code = body, status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f'HTTP {self.status_code}')

    def iter_content(self, n):
        for i in range(0, len(self.body), n):
            yield self.body[i:i + n]


def test_check_source_clasifica(monkeypatch):
    bodies = {
        'http://fresh.gz': gzip.compress(_xmltv('20260928110000', '20260928130000')),
        'http://stale.xml': _xmltv('20251213040000', '20251213050000'),
        'http://roto.xml': b'<html>no es xmltv</html>',
    }
    monkeypatch.setattr(d._session, 'get', lambda url, **kw: _Resp(bodies.get(url, b''), 200 if url in bodies else 404))
    cat = d.build_catalog([
        {'id': 'f', 'provider': 'p', 'country': 'ar', 'url': 'http://fresh.gz'},
        {'id': 's', 'provider': 'p', 'country': 'ar', 'url': 'http://stale.xml'},
        {'id': 'r', 'provider': 'p', 'country': 'ar', 'url': 'http://roto.xml'},
        {'id': 'x', 'provider': 'p', 'country': None, 'url': 'http://404.xml'},
        {'id': 'f', 'provider': 'p', 'country': 'ar', 'url': 'http://duplicado'},
    ], NOW)
    status = {s['id']: s['status'] for s in cat['sources']}
    assert status == {'f': 'fresh', 's': 'stale', 'r': 'down', 'x': 'down'}
    assert cat['summary'] == {'fresh': 1, 'stale': 1, 'down': 2}
    assert next(s for s in cat['sources'] if s['id'] == 'f')['url'] == 'http://fresh.gz', "gana el primero"


def test_open_epg_vacio_no_cuenta_como_existente(monkeypatch):
    """open-epg responde 200 con cuerpo vacío para archivos que no existen."""
    monkeypatch.setattr(d._session, 'get', lambda url, **kw: _Resp(b'' if 'no' in url else b'x'))
    assert d._exists('http://si') is True
    assert d._exists('http://no') is False
