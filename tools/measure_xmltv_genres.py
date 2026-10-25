"""Mide, sin IA y sin costo, cuánto género trae la propia guía (<category> de cada <programme>).

Lee merged.xml.gz (la guía fusionada de la corrida) y cuenta: qué porcentaje de programas trae categoría,
cuántas categorías distintas hay, y cuántos canales quedarían con género claro con la regla de
planes/categorias-por-genero.md (al menos MIN_PROGRAMS programas y MIN_SHARE de ellos con género).
Informativo: escribe el resumen en la página de la corrida (GITHUB_STEP_SUMMARY) y no cambia nada más.
"""
import collections
import gzip
import os
import sys

from lxml import etree

from xmltv_genres import genre_of

MERGED = 'merged.xml.gz'
MIN_PROGRAMS = 20
MIN_SHARE = 0.5

def measure(path):
    total = with_cat = with_genre = 0
    raw = collections.Counter()
    per_channel = collections.defaultdict(lambda: [0, 0])  # canal -> [programas, con género]
    with gzip.open(path, 'rb') as f:
        for _, el in etree.iterparse(f, events=('end',), tag='programme', huge_tree=True):
            total += 1
            cats = [(c.text or '').strip() for c in el.findall('category') if (c.text or '').strip()]
            genres = {genre_of(c) for c in cats} - {None}
            if cats:
                with_cat += 1
                raw.update(c.lower() for c in cats)
            if genres:
                with_genre += 1
            stats = per_channel[el.get('channel', '')]
            stats[0] += 1
            stats[1] += 1 if genres else 0
            el.clear()
            while el.getprevious() is not None:
                del el.getparent()[0]
    clear = [ch for ch, (n, g) in per_channel.items() if n >= MIN_PROGRAMS and g / n >= MIN_SHARE]
    enough = [ch for ch, (n, _) in per_channel.items() if n >= MIN_PROGRAMS]
    return {
        'total': total, 'with_cat': with_cat, 'with_genre': with_genre, 'channels': len(per_channel),
        'channels_enough': len(enough), 'channels_clear': len(clear), 'raw_top': raw.most_common(30),
    }


def pct(a, b):
    return f'{100 * a / b:.1f} %' if b else '—'


def report(r):
    t = r['total']
    lines = [
        '### Género en la guía (XMLTV, sin IA)',
        '',
        f"- Programas: {t:,}".replace(',', '.'),
        f"- Con alguna categoría XMLTV: {r['with_cat']:,} ({pct(r['with_cat'], t)})".replace(',', '.'),
        f"- Con un género de Grilla: {r['with_genre']:,} ({pct(r['with_genre'], t)})".replace(',', '.'),
        f"- Canales: {r['channels']}, con al menos {MIN_PROGRAMS} programas: {r['channels_enough']}",
        f"- Canales con género claro ({int(MIN_SHARE * 100)} % o más de sus programas): **{r['channels_clear']}**",
        '',
        '| Categoría XMLTV | Programas |',
        '|---|---:|',
    ]
    lines += [f'| {name} | {n} |' for name, n in r['raw_top']]
    return '\n'.join(lines) + '\n'


def main(argv):
    path = argv[1] if len(argv) > 1 else MERGED
    if not os.path.exists(path):
        print(f'No hay {path}: nada que medir.')
        return 0
    r = measure(path)
    text = report(r)
    print(text)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(text + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
