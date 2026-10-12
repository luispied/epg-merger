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

- Con --configs, además, los índices por hora de cada configuración (`cfg/<cfgId>`): lo mismo que el
  índice de toda la guía pero solo con sus canales (unos cientos de los ~17.500), en el mismo formato de
  tanda con una entrada por hora. Es lo que baja la Guía en el celular: ~20 KB por hora en vez de ~400 KB.

- Con --genres <ai/genres.json>, cada entrada de un programa que la IA ya clasificó (tools/classify_genres.py) lleva
  el género como quinto elemento: [inicio, fin, título, descripción o '', género]. Es lo que usa Tu plan para sugerir
  cosas parecidas a lo que se mira y para dejar afuera la publicidad. «Otro» no se agrega: no dice nada.

Uso: python tools/pack_schedule.py [--genres ai/genres.json] [out/schedule] [out/schedule_r2]
     python tools/pack_schedule.py --configs out/cfgs out/schedule out/schedule_cfg
"""
import gzip
import json
import os
import shutil
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.dirname(os.path.dirname(os.path.abspath(__file__)))]

SHARD_CHARS = 2  # 256 tandas
HEADER_DIGITS = 8


def _gz(data):
    # mtime=0: el mismo contenido da los mismos bytes.
    return gzip.compress(data, compresslevel=9, mtime=0)


def write_pack(path, members):
    """Tanda: 8 dígitos con el largo del encabezado, el encabezado {nombre: [desde, largo]} y cada parte en gzip."""
    index, parts, offset = {}, [], 0
    for name, data in members:
        member = _gz(data)
        index[name] = [offset, len(member)]
        parts.append(member)
        offset += len(member)
    header = json.dumps(index, separators=(',', ':')).encode()
    with open(path, 'wb') as out:
        out.write(f'{len(header):0{HEADER_DIGITS}d}'.encode())
        out.write(header)
        for member in parts:
            out.write(member)


NO_GENRE = {'Otro'}


def tag_genres(raw, genres):
    """El JSON de un canal con el género de cada programa clasificado como quinto elemento; igual si no hay ninguno."""
    from measure_titles import title_key
    try:
        entries = json.loads(raw)
    except ValueError:
        return raw
    if not isinstance(entries, list):
        return raw
    out, tagged = [], 0
    for e in entries:
        genre = (genres.get(title_key(e[2])) or [None])[0] if isinstance(e, list) and len(e) >= 3 else None
        if genre and genre not in NO_GENRE:
            out.append([e[0], e[1], e[2], e[3] if len(e) > 3 else '', genre])
            tagged += 1
        else:
            out.append(e)
    if not tagged:
        return raw
    return json.dumps(out, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def pack(src, dst, genres=None):
    """Devuelve (canales, tandas, horas) empacados. Con `genres` ({clave del título: [género, …]}), los programas
    clasificados llevan su género."""
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
        members = []
        for f in files:
            with open(os.path.join(src, f'{f}.json'), 'rb') as fh:
                raw = fh.read()
            members.append((f, tag_genres(raw, genres) if genres else raw))
        write_pack(os.path.join(dst, 's', prefix), members)
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


def config_ids(config):
    """Los ids de guía de una configuración como los usa el índice por hora (el alias del canal)."""
    from config_epgs import chosen_ids
    from source_alias import channel_alias, is_channel_alias
    return {i if is_channel_alias(i) else channel_alias(i) for i in chosen_ids(config)}


def filter_hour(index, ids):
    """El índice de una hora solo con esos canales, con su propia lista de títulos."""
    titles, remap, channels = [], {}, {}
    for cid in sorted(ids & index['c'].keys()):
        rows = []
        for start, stop, t in index['c'][cid]:
            if t not in remap:
                remap[t] = len(titles)
                titles.append(index['t'][t])
            rows.append([start, stop, remap[t]])
        channels[cid] = rows
    return {'h': index['h'], 't': titles, 'c': channels}


def pack_configs(configs, src, dst):
    """Un archivo por configuración con su índice de cada hora (cfg/<cfgId> en R2). Devuelve cuántos."""
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst)
    hour_dir = os.path.join(src, 'hour')
    hours = []
    for name in sorted(os.listdir(hour_dir)) if os.path.isdir(hour_dir) else []:
        if name.endswith('.json') and not name.endswith('-d.json'):
            with open(os.path.join(hour_dir, name), encoding='utf-8') as f:
                hours.append((name[:-len('.json')], json.load(f)))
    for cfg_id, config in configs.items():
        ids = config_ids(config)
        write_pack(os.path.join(dst, cfg_id), [
            (key, json.dumps(filter_hour(index, ids), ensure_ascii=False, separators=(',', ':')).encode())
            for key, index in hours])
    return len(configs)


def hours_from_merged(merged, out_dir):
    """Los índices por hora (sin descripciones ni archivos por canal) armados de un merged.xml.gz, para
    refresh_epgs.py: la configuración nueva o editada no espera a la corrida diaria."""
    import generate_playlist as gp
    from source_alias import channel_alias
    collector = gp.ScheduleCollector()
    for programme in gp.iter_programmes(merged):
        collector.add(programme)
    entries = {channel_alias(cid): sorted(e)[:gp.SCHEDULE_MAX_ENTRIES] for cid, e in collector.by_channel.items()}
    gp.write_hourly_index(entries, os.path.join(out_dir, 'hour'), collector.window_start, collector.window_end)
    return out_dir


def _size(path):
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(path) for f in fs)


def main(argv):
    if len(argv) > 1 and argv[1] == '--configs':
        from config_epgs import load_configs
        configs_dir, src, dst = argv[2:5]
        if not os.path.isdir(src) or not os.path.isdir(configs_dir):
            print('ℹ️  Sin programación o sin configuraciones: no hay índices por configuración.')
            return 0
        n = pack_configs(load_configs(configs_dir), src, dst)
        print(f'📦 Índices por hora de {n} configuración(es): {_size(dst) / 1e6:.1f} MB')
        return 0
    argv = list(argv)
    genres = None
    if '--genres' in argv:
        i = argv.index('--genres')
        path = argv[i + 1]
        del argv[i:i + 2]
        try:
            with open(path, encoding='utf-8') as f:
                genres = json.load(f)
        except (OSError, ValueError):
            print(f'ℹ️  Sin {path} legible: la programación sale sin géneros.')
    src = argv[1] if len(argv) > 1 else os.path.join('out', 'schedule')
    dst = argv[2] if len(argv) > 2 else os.path.join('out', 'schedule_r2')
    if not os.path.isdir(src):
        print(f'ℹ️  Sin {src}: no hay programación para empacar.')
        return 0
    channels, shards, hours = pack(src, dst, genres)
    print(f'📦 Programación para R2: {channels} canales en {shards} tandas y {hours} archivos por hora, '
          f'{_size(src) / 1e6:.0f} MB → {_size(dst) / 1e6:.0f} MB'
          + (f', con el género de {len(genres)} títulos' if genres else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
