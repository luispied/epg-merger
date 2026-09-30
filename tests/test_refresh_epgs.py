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
