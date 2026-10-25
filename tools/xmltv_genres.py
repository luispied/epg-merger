"""Género de cada título sacado de la propia guía (<category> de XMLTV), sin IA y sin costo.

Muchas fuentes traen una categoría por programa («Movie», «Sports», «News»…). Acá se pasan a los géneros de Grilla
(los mismos que la IA: tools/classify_genres.py) y cada título queda con el género que más aparece para él.
La IA, cuando clasificó un título, le gana a la guía, salvo que haya dicho «Otro».

Lo usa refresh_epgs.py para el índice por hora (el filtro por género de la Guía y de Tu plan). Los temas
(topics.json) siguen saliendo solo de la IA.
"""
import collections
import gzip
import unicodedata

from lxml import etree

from measure_titles import title_key

# Categorías XMLTV (en minúscula, sin tildes) → género de Grilla. Lo que no esté acá no cuenta como género.
GENRE_WORDS = {
    'movie': 'Película', 'movies': 'Película', 'film': 'Película', 'films': 'Película', 'pelicula': 'Película',
    'peliculas': 'Película', 'cine': 'Película',
    'series': 'Serie', 'serie': 'Serie', 'tv series': 'Serie', 'drama': 'Serie', 'soap': 'Telenovela',
    'telenovela': 'Telenovela', 'telenovelas': 'Telenovela',
    'sport': 'Deportes', 'sports': 'Deportes', 'deporte': 'Deportes', 'deportes': 'Deportes', 'futbol': 'Deportes',
    'football': 'Deportes', 'soccer': 'Deportes', 'milb': 'Deportes', 'mlb': 'Deportes', 'nba': 'Deportes',
    'nfl': 'Deportes', 'nhl': 'Deportes', 'tennis': 'Deportes', 'golf': 'Deportes', 'boxing': 'Deportes',
    'mma': 'Deportes', 'motorsport': 'Deportes', 'racing': 'Deportes',
    'news': 'Noticias', 'noticias': 'Noticias', 'noticia': 'Noticias', 'current affairs': 'Noticias',
    'documentary': 'Documental', 'documentaries': 'Documental', 'documental': 'Documental', 'documentales': 'Documental',
    'kids': 'Infantil', 'children': 'Infantil', 'childrens': 'Infantil', 'cartoon': 'Infantil', 'cartoons': 'Infantil',
    'infantil': 'Infantil',
    'music': 'Música', 'musica': 'Música', 'musical': 'Música',
    'reality': 'Reality', 'reality show': 'Reality',
    'cooking': 'Cocina', 'food': 'Cocina', 'cocina': 'Cocina',
    'lifestyle': 'Estilo de vida', 'estilo de vida': 'Estilo de vida', 'travel': 'Estilo de vida',
    'comedy': 'Humor', 'humor': 'Humor',
    'religion': 'Religión', 'religious': 'Religión', 'religión': 'Religión',
    'education': 'Educativo', 'educational': 'Educativo', 'educativo': 'Educativo',
    'entertainment': 'Entretenimiento', 'talk show': 'Entretenimiento', 'game show': 'Entretenimiento',
    'quiz': 'Entretenimiento', 'entretenimiento': 'Entretenimiento',
    'shopping': 'Publicidad', 'advertisement': 'Publicidad', 'infomercial': 'Publicidad',
}


def _fold(text):
    """Minúscula, sin tildes y con los espacios juntos: «Fútbol  Liga» → «futbol liga»."""
    text = unicodedata.normalize('NFD', text or '')
    text = ''.join(c for c in text if unicodedata.category(c) != 'Mn')
    return ' '.join(text.lower().split())


def genre_of(category):
    """Género de Grilla para una categoría XMLTV, o None si no es un género conocido."""
    return GENRE_WORDS.get(_fold(category))


def from_guide(path):
    """{clave del título: [género, [], False, '']} con el género más frecuente de cada título de la guía fusionada
    (`path`, merged.xml.gz). Mismo formato que ai/genres.json, así pack_schedule lo usa igual."""
    votes = collections.defaultdict(collections.Counter)
    with gzip.open(path, 'rb') as f:
        for _, el in etree.iterparse(f, events=('end',), tag='programme', huge_tree=True):
            title = (el.findtext('title') or '').strip()
            if title:
                genres = {genre_of(c.text) for c in el.findall('category') if c.text} - {None}
                for g in genres:
                    votes[title_key(title)][g] += 1
            el.clear()
            while el.getprevious() is not None:
                del el.getparent()[0]
    return {key: [counts.most_common(1)[0][0], [], False, ''] for key, counts in votes.items()}


def merge(ai, guide):
    """Une los géneros: los de la IA ganan, salvo que hayan dicho «Otro» (o nada). Devuelve un dict nuevo."""
    out = dict(guide)
    for key, info in (ai or {}).items():
        if info and info[0] and info[0] != 'Otro':
            out[key] = info
    return out
