#!/usr/bin/env python3
"""Resume lo que mostró `wrangler tail --format json` de las corridas programadas (cron) del Worker: hora, cron,
resultado (ok, exceededCpu, exception…), excepciones y mensajes. Solo lee. Tapa todo lo que parezca un id o una
clave (16 caracteres o más seguidos) y no muestra los pedidos web, solo las corridas del cron.

Uso: `python tools/ver_cron.py tail.json`, o el workflow «Ver el cron del Worker».
"""
import datetime
import json
import re
import sys

_ID = re.compile(r'[A-Za-z0-9_\-]{16,}')


def tapar(texto):
    return _ID.sub('…', str(texto))[:200]


def eventos(texto):
    """Los objetos JSON de la salida, uno detrás de otro (vienen en varias líneas); lo que no es JSON se saltea."""
    dec, i, out = json.JSONDecoder(), 0, []
    while True:
        i = texto.find('{', i)
        if i < 0:
            return out
        try:
            obj, fin = dec.raw_decode(texto, i)
        except ValueError:
            i += 1
            continue
        out.append(obj)
        i = fin


def lineas(evs):
    out = []
    for e in evs:
        ev = e.get('event') or {}
        if not isinstance(ev, dict) or 'cron' not in ev:
            continue
        ms = e.get('eventTimestamp') or 0
        hora = datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime('%H:%M:%S') if ms else '?'
        extra = ' '.join(f'{k}={e[k]}' for k in ('cpuTime', 'wallTime') if e.get(k) is not None)
        out.append(f"- {hora} cron «{ev.get('cron')}»: {e.get('outcome')} {extra}".rstrip())
        for x in e.get('exceptions') or []:
            out.append(f"    excepción {tapar(x.get('name'))}: {tapar(x.get('message'))}")
        for log in e.get('logs') or []:
            out.append(f"    {log.get('level')}: {tapar(' '.join(str(m) for m in (log.get('message') or [])))}")
    return out


def main():
    with open(sys.argv[1], encoding='utf-8', errors='replace') as f:
        evs = eventos(f.read())
    ls = lineas(evs)
    print(f'{len(evs)} eventos, {sum(1 for x in ls if x.startswith("- "))} del cron\n')
    print('\n'.join(ls) or 'Ninguna corrida del cron en este rato.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
