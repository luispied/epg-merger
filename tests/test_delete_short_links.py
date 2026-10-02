"""tools/delete_short_links.py: borrar todos los links cortos y nada más."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools'))

from delete_short_links import delete_all  # noqa: E402
from test_delete_cfg import MemR2  # noqa: E402


def test_borra_short_y_devices_y_no_toca_el_resto():
    r2 = MemR2({
        'short/aaaaaaaa.json': b'{}', 'short/bbbbbbbb.json': b'{}', 'devices/cfg1.json': b'{}',
        'cfg/cfg1.json': b'{}', 'list/cfg1.json': b'{}', 'epg/cfg1.xml.gz': b'x', 'links/h.json': b'{}',
    })
    assert delete_all(r2) == {'short/': 2, 'devices/': 1}
    assert sorted(r2.d) == ['cfg/cfg1.json', 'epg/cfg1.xml.gz', 'links/h.json', 'list/cfg1.json']
