import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))

import measure_xmltv_genres as m  # noqa: E402


def test_genre_of_maps_known_categories_and_ignores_the_rest():
    assert m.genre_of('Movie') == 'Película'
    assert m.genre_of('  Fútbol ') == 'Deportes'
    assert m.genre_of('Kids') == 'Infantil'
    assert m.genre_of('Varios') is None
    assert m.genre_of(None) is None
