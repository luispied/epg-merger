import gzip
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))

import xmltv_genres as xg  # noqa: E402
from measure_titles import title_key  # noqa: E402


def test_genre_of_maps_known_categories_and_ignores_the_rest():
    assert xg.genre_of('Movie') == 'Película'
    assert xg.genre_of('  Fútbol ') == 'Deportes'
    assert xg.genre_of('MILB') == 'Deportes'
    assert xg.genre_of('Kids') == 'Infantil'
    assert xg.genre_of('adventure') is None
    assert xg.genre_of(None) is None


def test_from_guide_takes_the_most_frequent_genre_per_title(tmp_path):
    xml = b'''<tv>
<programme channel="a" start="1"><title>Noticiero</title><category>News</category></programme>
<programme channel="a" start="2"><title>Noticiero</title><category>News</category><category>Varios</category></programme>
<programme channel="b" start="3"><title>Noticiero</title><category>Sports</category></programme>
<programme channel="b" start="4"><title>Sin categoria</title></programme>
</tv>'''
    path = tmp_path / 'merged.xml.gz'
    path.write_bytes(gzip.compress(xml))
    guide = xg.from_guide(str(path))
    assert guide == {title_key('Noticiero'): ['Noticias', [], False, '']}


def test_merge_lets_ai_win_unless_it_said_otro():
    guide = {'a': ['Noticias', [], False, ''], 'b': ['Deportes', [], False, '']}
    ai = {'a': ['Documental', ['x'], False, ''], 'b': ['Otro', [], False, ''], 'c': ['Serie', [], True, '']}
    out = xg.merge(ai, guide)
    assert out['a'] == ['Documental', ['x'], False, '']
    assert out['b'] == ['Deportes', [], False, '']
    assert out['c'] == ['Serie', [], True, '']
    assert guide['a'][0] == 'Noticias'  # no toca el dict de la guía
    assert xg.merge(None, guide) == guide
