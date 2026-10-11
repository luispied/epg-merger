"""Empaca la programación de la corrida (out/schedule/, la que escribe generate_playlist.py) para R2.

Antes se subía tal cual: un archivo por canal (unos 17.500) y dos por hora, ~200 MB y una escritura
de clase A por archivo todos los días (más de la mitad de las gratis del mes). Ahora:

- Los canales van en 256 tandas (`s/<xx>`, por los dos primeros caracteres del nombre de archivo).
  Cada tanda es: 8 dígitos con el largo del encabezado, el encabezado (JSON {archivo: [desde, largo]},
  posiciones contadas desde el fin del encabezado) y la programación de cada canal comprimida con
  gzip, una detrás de otra. El Worker lee el encabezado y después solo los bytes de ese canal (dos
  lecturas por rango) y los sirve comprimidos tal cual (src/schedule.ts).
- Los índices por hora (`hour/<AAAAMMDDHH>.json` y `-d.json`) van enteros, comprimidos con gzip:
  se suben con Content-Encoding: gzip y el navegador los descomprime solo.

Uso: python tools/pack_schedule.py [out/schedule] [out/schedule_r2]
"""
import gzip
import json
import os
import shutil
import sys

SHARD_CHARS = 2  # 256 tandas
HEADER_DIGITS = 8


def _gz(data):
    # mtime=0: el mismo contenido da los mismos bytes.
    return gzip.compress(data, compresslevel=9, mtime=0)


def pack(src, dst):
    """Devuelve (canales, tandas, horas) empacados."""
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(os.path.join(dst, 's'))
    shards = {}
    for name in sorted(os.listdir(src)):
        path = os.path.join(src, name)
        if name.endswith('.json') and os.path.isfile(path):
            shards.setdefault(name[:SHARD_CHARS], []).append(name[:-len('.json')])
    channels = 0
    for prefix, files in shards.items():
        index, parts, offset = {}, [], 0
        for f in files:
            with open(os.path.join(src, f'{f}.json'), 'rb') as fh:
                member = _gz(fh.read())
            index[f] = [offset, len(member)]
            parts.append(member)
            offset += len(member)
        header = json.dumps(index, separators=(',', ':')).encode()
        with open(os.path.join(dst, 's', prefix), 'wb') as out:
            out.write(f'{len(header):0{HEADER_DIGITS}d}'.encode())
            out.write(header)
            for member in parts:
                out.write(member)
        channels += len(files)

    hours = 0
    hour_src = os.path.join(src, 'hour')
    if os.path.isdir(hour_src):
        os.makedirs(os.path.join(dst, 'hour'))
        for name in sorted(os.listdir(hour_src)):
            if name.endswith('.json'):
                with open(os.path.join(hour_src, name), 'rb') as fh, open(os.path.join(dst, 'hour', name), 'wb') as out:
                    out.write(_gz(fh.read()))
                hours += 1
    return channels, len(shards), hours


def _size(path):
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(path) for f in fs)


def main(argv):
    src = argv[1] if len(argv) > 1 else os.path.join('out', 'schedule')
    dst = argv[2] if len(argv) > 2 else os.path.join('out', 'schedule_r2')
    if not os.path.isdir(src):
        print(f'ℹ️  Sin {src}: no hay programación para empacar.')
        return 0
    channels, shards, hours = pack(src, dst)
    print(f'📦 Programación para R2: {channels} canales en {shards} tandas y {hours} archivos por hora, '
          f'{_size(src) / 1e6:.0f} MB → {_size(dst) / 1e6:.0f} MB')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
