"""Tests de los proveedores de canales (Xtream y M3U)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from providers import M3UProvider, ProviderError, XtreamProvider, parse_m3u

M3U = '''#EXTM3U url-tvg="http://guia/epg.xml"
#EXTINF:-1 tvg-id="TBS.us" tvg-name="TBS HD" tvg-logo="http://logo/tbs.png" group-title="USA, Entretenimiento",TBS HD
http://prov/live/1.ts
#EXTINF:-1 group-title="Noticias",CNN, en español
#EXTVLCOPT:http-user-agent=Algo
http://prov/live/2.ts

#EXTINF:0,Sin grupo
#EXTGRP:Deportes
http://prov/live/3.ts
#EXTINF:-1 tvg-id="" group-title="Noticias",Sin tvg-id
http://prov/live/4.ts
#EXTINF:-1 group-title="Huérfano",Sin URL
'''


def test_parse_m3u_extrae_nombre_categoria_logo_e_id():
    chs = parse_m3u(M3U)
    assert [c['name'] for c in chs] == ['TBS HD', 'CNN, en español', 'Sin grupo', 'Sin tvg-id']
    assert chs[0] == {'name': 'TBS HD', 'category': 'USA, Entretenimiento', 'url': 'http://prov/live/1.ts',
                      'icon': 'http://logo/tbs.png', 'epg_channel_id': 'TBS.us'}
    assert chs[1]['category'] == 'Noticias' and chs[1]['url'] == 'http://prov/live/2.ts'
    assert chs[2]['category'] == 'Deportes', "#EXTGRP cuando no hay group-title"
    assert chs[3]['epg_channel_id'] is None, "tvg-id vacío = sin sugerencia de EPG"


def test_m3u_provider_lee_archivo_y_falla_claro(tmp_path):
    f = tmp_path / 'lista.m3u'
    f.write_text(M3U, encoding='utf-8')
    assert len(M3UProvider({'url': str(f)}).load()) == 4
    (tmp_path / 'vacia.m3u').write_text('#EXTM3U\n', encoding='utf-8')
    with pytest.raises(ProviderError):
        M3UProvider({'url': str(tmp_path / 'vacia.m3u')}).load()
    with pytest.raises(ProviderError):
        M3UProvider({'url': str(tmp_path / 'no-existe.m3u')}).load()


def test_xtream_provider_arma_urls_y_categorias():
    streams = [{'name': 'TBS -EN', 'stream_id': 7, 'category_id': 1, 'container_extension': 'ts',
                'stream_icon': 'http://i', 'epg_channel_id': 'TBS.us'},
               {'name': 'Sin cat', 'stream_id': 8, 'category_id': 99}]
    prov = XtreamProvider({'servers': ['http://s:80'], 'username': 'u', 'password': 'p'},
                          get_streams=lambda servers, u, p: (servers[0], streams),
                          get_categories=lambda s, u, p: {'1': 'USA'})
    chs = prov.load()
    assert chs[0] == {'name': 'TBS -EN', 'category': 'USA', 'url': 'http://s:80/live/u/p/7.ts',
                      'icon': 'http://i', 'epg_channel_id': 'TBS.us'}
    assert chs[1]['category'] == 'General' and chs[1]['url'].endswith('/8.m3u8')
