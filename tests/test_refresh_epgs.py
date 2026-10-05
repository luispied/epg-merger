"""Guía de Grilla web para configuraciones nuevas o cambiadas (tools/refresh_epgs.py)."""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

import refresh_epgs  # noqa: E402

T = datetime.datetime(2026, 9, 30, 12, tzinfo=datetime.timezone.utc)


def test_solo_las_configuraciones_sin_guia_o_con_guia_vieja():
    configs = {'nueva': T, 'editada': T, 'al-dia': T}
    epgs = {'editada': T - datetime.timedelta(minutes=5), 'al-dia': T + datetime.timedelta(minutes=1), 'borrada': T}
    assert refresh_epgs.stale(configs, epgs) == ['editada', 'nueva']


class _Paginator:
    def paginate(self, Bucket, Prefix):
        yield {'Contents': [{'Key': f'{Prefix}abc.json', 'LastModified': T}, {'Key': Prefix, 'LastModified': T}]}


class _Client:
    def get_paginator(self, name):
        return _Paginator()


def test_listado_por_prefijo():
    assert refresh_epgs.listing(_Client(), 'b', 'cfg/') == {'abc': T}


class _Resp:
    def __init__(self, payload=None, body=b''):
        self.payload, self.body = payload, body

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload

    def iter_content(self, _n):
        yield self.body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


def test_baja_el_merged_con_token_por_la_api(tmp_path, monkeypatch):
    """Con token (repo privado) pide el release por la API y baja el asset con Accept: octet-stream."""
    calls = []

    def fake_get(url, headers=None, **_):
        calls.append((url, dict(headers or {})))
        if url.endswith('/releases/tags/latest'):
            return _Resp({'assets': [{'name': 'otro.json', 'url': 'u0'}, {'name': 'merged.xml.gz', 'url': 'https://api/asset/1'}]})
        return _Resp(body=b'GZ')

    monkeypatch.setattr(refresh_epgs.requests, 'get', fake_get)
    dest = tmp_path / 'merged.xml.gz'
    refresh_epgs.download_merged('yo/repo', str(dest), 'TOKEN')
    assert dest.read_bytes() == b'GZ'
    assert calls[0][0] == 'https://api.github.com/repos/yo/repo/releases/tags/latest'
    assert calls[0][1]['Authorization'] == 'Bearer TOKEN'
    assert calls[1] == ('https://api/asset/1', {'Authorization': 'Bearer TOKEN', 'Accept': 'application/octet-stream'})


def test_baja_el_merged_sin_token_por_la_url_publica(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(refresh_epgs.requests, 'get', lambda url, headers=None, **_: (seen.append((url, headers)), _Resp(body=b'X'))[1])
    refresh_epgs.download_merged('yo/repo', str(tmp_path / 'm.gz'))
    assert seen == [('https://github.com/yo/repo/releases/download/latest/merged.xml.gz', {})]
