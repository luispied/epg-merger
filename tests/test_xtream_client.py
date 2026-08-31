"""Tests del failover entre servidores del cliente Xtream."""
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from xtream_client import XtreamError, get_live_streams


class _FakeResponse:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self._data


def test_salta_al_siguiente_servidor_si_el_primero_falla(monkeypatch):
    llamadas = []

    def fake_get(url, params, timeout):
        llamadas.append(url)
        if 'caido' in url:
            raise requests.ConnectionError('no responde')
        return _FakeResponse([{'name': 'canal1'}])

    monkeypatch.setattr(requests, 'get', fake_get)

    server, streams = get_live_streams(
        ['http://caido:8080', 'http://ok:8080'], 'u', 'p')

    assert server == 'http://ok:8080'
    assert streams == [{'name': 'canal1'}]
    assert len(llamadas) == 2


def test_si_todos_los_servidores_fallan_levanta_error(monkeypatch):
    def fake_get(url, params, timeout):
        raise requests.Timeout('sin respuesta')

    monkeypatch.setattr(requests, 'get', fake_get)

    with pytest.raises(XtreamError):
        get_live_streams(['http://a:8080', 'http://b:8080'], 'u', 'p')


def test_usa_el_primer_servidor_si_responde_bien(monkeypatch):
    llamadas = []

    def fake_get(url, params, timeout):
        llamadas.append(url)
        return _FakeResponse([])

    monkeypatch.setattr(requests, 'get', fake_get)

    server, _ = get_live_streams(['http://a:8080', 'http://b:8080'], 'u', 'p')

    assert server == 'http://a:8080'
    assert len(llamadas) == 1
