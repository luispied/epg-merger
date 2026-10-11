#!/usr/bin/env python3
"""Registro interno de cuánto consumen los servidores de Nowline, para ver si nos pasamos de lo gratis.

Lo corre una vez por día .github/workflows/consumo.yml. Junta lo de ayer (y lo que va del mes) y lo deja en un issue de
GitHub, «Consumo de servidores»: el cuerpo se reescribe con la tabla al día (no avisa a nadie) y solo se agrega un
comentario, que sí avisa, la primera vez en el mes que algo pasa el 70 % de lo gratis.

Qué mide, y con qué (cada parte es opcional: sin su credencial se saltea y lo dice):
- R2 (almacenamiento): tamaño y cantidad de objetos, por carpeta. Con las credenciales de R2 que ya usan los workflows.
- Worker y R2 (operaciones): pedidos por día, errores y CPU del Worker; operaciones clase A y B de R2 en el mes. Con la
  API de analíticas de Cloudflare (CLOUDFLARE_ANALYTICS_TOKEN: un token con «Account Analytics: Read»).
- Relay en Fly: tráfico de salida y de entrada, y horas encendido. Con las métricas de Fly (FLY_READ_TOKEN: un token de
  solo lectura, `fly tokens create readonly`).

No lee ni escribe nada de las configuraciones, los links ni las cuentas: solo totales.
"""
import datetime
import json
import os
import re
import sys

import requests

# Lo gratis de cada servicio (planes gratuitos a octubre de 2026). Fly ya no tiene plan gratis para cuentas nuevas: lo
# que se usa como tope es lo que incluye el plan heredado para la región del relay (gru), aproximado.
LIMITS = {
    'worker_requests_day': 100_000,
    'worker_cpu_ms': 10,
    'r2_storage_bytes': 10 * 1000 ** 3,
    'r2_class_a_month': 1_000_000,
    'r2_class_b_month': 10_000_000,
    'fly_out_bytes_month': 30 * 1000 ** 3,
}
WARN_AT = 0.7
ISSUE_TITLE = 'Consumo de servidores'
ISSUE_LABEL = 'consumo'
HISTORY_DAYS = 90
SCRIPT = os.environ.get('WORKER_NAME', 'grilla')
FLY_APP = os.environ.get('FLY_APP', 'epg-merger')
FLY_ORG = os.environ.get('FLY_ORG', 'personal')
TIMEOUT = 30

# Operaciones de R2: las que no son de clase B ni gratis son de clase A.
R2_CLASS_B = {'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation',
              'GetBucketCors', 'GetBucketLifecycleConfiguration'}
R2_FREE = {'DeleteObject', 'DeleteObjects', 'DeleteBucket', 'AbortMultipartUpload'}


def log(msg):
    print(msg, file=sys.stderr)


# ------------------------------------------------------------------ R2: almacenamiento por carpeta
def r2_storage(client, bucket):
    total, count, by_prefix = 0, 0, {}
    token = None
    while True:
        kw = {'Bucket': bucket, 'MaxKeys': 1000, **({'ContinuationToken': token} if token else {})}
        page = client.list_objects_v2(**kw)
        for obj in page.get('Contents', []):
            total += obj['Size']
            count += 1
            top = obj['Key'].split('/', 1)[0] if '/' in obj['Key'] else '(raíz)'
            by_prefix[top] = by_prefix.get(top, 0) + obj['Size']
        if not page.get('IsTruncated'):
            break
        token = page['NextContinuationToken']
    return {'r2_bytes': total, 'r2_objects': count, 'r2_prefixes': dict(sorted(by_prefix.items(), key=lambda kv: -kv[1])[:8])}


# ------------------------------------------------------------------ Cloudflare: Worker y operaciones de R2
CF_QUERY = '''query($acct: String!, $script: String!, $dayFrom: Time!, $dayTo: Time!, $monthFrom: Time!) {
  viewer { accounts(filter: {accountTag: $acct}) {
    worker: workersInvocationsAdaptive(limit: 10, filter: {scriptName: $script, datetime_geq: $dayFrom, datetime_lt: $dayTo}) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
    }
    r2: r2OperationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $monthFrom, datetime_lt: $dayTo}) {
      sum { requests }
      dimensions { actionType }
    }
  } }
}'''


def r2_classes(rows):
    a = b = 0
    for row in rows:
        action, n = row['dimensions']['actionType'], row['sum']['requests']
        if action in R2_FREE:
            continue
        if action in R2_CLASS_B:
            b += n
        else:
            a += n
    return a, b


def cloudflare(token, account, day, post=requests.post):
    start = datetime.datetime.combine(day, datetime.time(), datetime.timezone.utc)
    variables = {
        'acct': account, 'script': SCRIPT,
        'dayFrom': start.isoformat().replace('+00:00', 'Z'),
        'dayTo': (start + datetime.timedelta(days=1)).isoformat().replace('+00:00', 'Z'),
        'monthFrom': start.replace(day=1).isoformat().replace('+00:00', 'Z'),
    }
    r = post('https://api.cloudflare.com/client/v4/graphql', json={'query': CF_QUERY, 'variables': variables},
             headers={'Authorization': f'Bearer {token}'}, timeout=TIMEOUT)
    r.raise_for_status()
    data = r.json()
    if data.get('errors'):
        raise RuntimeError('; '.join(e.get('message', '?') for e in data['errors'])[:300])
    acct = data['data']['viewer']['accounts'][0]
    req = err = sub = 0
    p50 = p99 = 0.0
    for row in acct['worker']:
        req += row['sum']['requests']
        err += row['sum']['errors']
        sub += row['sum']['subrequests']
        p50 = max(p50, row['quantiles']['cpuTimeP50'])
        p99 = max(p99, row['quantiles']['cpuTimeP99'])
    a, b = r2_classes(acct['r2'])
    # cpuTime viene en microsegundos.
    return {'worker_requests': req, 'worker_errors': err, 'worker_subrequests': sub,
            'worker_cpu_p50_ms': round(p50 / 1000, 2), 'worker_cpu_p99_ms': round(p99 / 1000, 2),
            'r2_class_a_month': a, 'r2_class_b_month': b}


# ------------------------------------------------------------------ Fly: tráfico y horas del relay
def fly(token, day, get=requests.get):
    end = datetime.datetime.combine(day + datetime.timedelta(days=1), datetime.time(), datetime.timezone.utc)
    month_h = max(1, int((end - end.replace(day=1)).total_seconds() // 3600))
    base = f'https://api.fly.io/prometheus/{FLY_ORG}/api/v1/query'
    # Los tokens de Fly vienen como «FlyV1 fm2_…» y van tal cual en el encabezado; los viejos, sin prefijo, con Bearer.
    token = token.strip()
    headers = {'Authorization': token if token.startswith('FlyV1 ') else f'Bearer {token}'}

    def q(expr):
        r = get(base, params={'query': expr, 'time': end.timestamp()}, headers=headers, timeout=TIMEOUT)
        r.raise_for_status()
        res = r.json().get('data', {}).get('result', [])
        return sum(float(x['value'][1]) for x in res)

    app = f'app="{FLY_APP}"'
    return {
        'fly_out_bytes': round(q(f'sum(increase(fly_instance_net_sent_bytes{{{app}}}[24h]))')),
        'fly_in_bytes': round(q(f'sum(increase(fly_instance_net_recv_bytes{{{app}}}[24h]))')),
        'fly_out_bytes_month': round(q(f'sum(increase(fly_instance_net_sent_bytes{{{app}}}[{month_h}h]))')),
        'fly_up_hours': round(q(f'sum(avg_over_time(fly_instance_up{{{app}}}[24h])) * 24'), 1),
    }


# ------------------------------------------------------------------ historial y texto del issue
HIST_RE = re.compile(r'<!-- consumo:(.*?) -->', re.S)


def load_history(body):
    m = HIST_RE.search(body or '')
    if not m:
        return {'rows': [], 'warned': {}}
    try:
        data = json.loads(m.group(1))
        return {'rows': data.get('rows', []), 'warned': data.get('warned', {})}
    except ValueError:
        return {'rows': [], 'warned': {}}


def merge_row(hist, row):
    rows = [r for r in hist['rows'] if r.get('date') != row['date']] + [row]
    rows.sort(key=lambda r: r['date'])
    return {**hist, 'rows': rows[-HISTORY_DAYS:]}


def usage(row):
    """(clave, nombre, usado, tope) de lo que tiene tope gratis y se midió."""
    out = []
    if 'worker_requests' in row:
        out.append(('worker_requests_day', 'Pedidos al Worker (ayer)', row['worker_requests'], LIMITS['worker_requests_day']))
        # El tope de 10 ms del plan gratis no corta por un pedido suelto (Cloudflare deja pasar picos): lo que hay que
        # mirar es el pedido típico. El p99 queda en la tabla de los últimos días, y un pedido cortado sale en errores.
        out.append(('worker_cpu_ms', 'CPU del Worker, pedido típico (ms)', row['worker_cpu_p50_ms'], LIMITS['worker_cpu_ms']))
        out.append(('worker_errors_day', 'Errores del Worker (ayer)', row['worker_errors'], 0))
    if 'r2_bytes' in row:
        out.append(('r2_storage_bytes', 'Almacenamiento en R2', row['r2_bytes'], LIMITS['r2_storage_bytes']))
    if 'r2_class_a_month' in row:
        out.append(('r2_class_a_month', 'R2 clase A (escrituras y listados, en el mes)', row['r2_class_a_month'], LIMITS['r2_class_a_month']))
        out.append(('r2_class_b_month', 'R2 clase B (lecturas, en el mes)', row['r2_class_b_month'], LIMITS['r2_class_b_month']))
    if 'fly_out_bytes_month' in row:
        out.append(('fly_out_bytes_month', 'Relay: salida en el mes (aprox.)', row['fly_out_bytes_month'], LIMITS['fly_out_bytes_month']))
    return out


def human(key, n):
    if 'bytes' in key:
        for unit, size in (('GB', 1000 ** 3), ('MB', 1000 ** 2), ('KB', 1000)):
            if n >= size:
                return f'{n / size:.1f} {unit}'
        return f'{n} B'
    if isinstance(n, float):
        return f'{n:g}'
    return f'{n:,}'.replace(',', '.')


def new_warnings(hist, row):
    """Lo que pasó el 70 % y todavía no se avisó este mes."""
    month = row['date'][:7]
    return [(k, name, used, cap) for k, name, used, cap in usage(row)
            if cap and used / cap >= WARN_AT and hist['warned'].get(k) != month]


def render(hist, notes):
    rows = hist['rows']
    last = rows[-1] if rows else {}
    lines = [f'Registro interno de cuánto consumen los servidores de Nowline, contra lo gratis de cada uno. Lo actualiza '
             f'todos los días `.github/workflows/consumo.yml`; se avisa con un comentario cuando algo pasa el '
             f'{int(WARN_AT * 100)} %.', '', f'## Al {last.get("date", "—")}', '',
             '| | Usado | Gratis | % |', '|---|---:|---:|---:|']
    for k, name, used, cap in usage(last):
        if not cap:
            lines.append(f'| {name} | {human(k, used)} | | |')
            continue
        pct = used / cap * 100
        flag = ' ⚠️' if pct >= WARN_AT * 100 else ''
        lines.append(f'| {name} | {human(k, used)} | {human(k, cap)} | {pct:.0f} %{flag} |')
    if 'fly_up_hours' in last:
        lines.append(f'| Relay: horas encendido (ayer) | {last["fly_up_hours"]:g} h | | |')
    if last.get('r2_prefixes'):
        lines += ['', 'R2 por carpeta: ' + ', '.join(f'`{p}` {human("bytes", b)}' for p, b in last['r2_prefixes'].items())]
    if notes:
        lines += ['', *[f'> {n}' for n in notes]]
    lines += ['', '## Últimos días', '', '| Día | Pedidos Worker | CPU p99 | R2 | R2 A (mes) | R2 B (mes) | Relay salida | Relay entrada |',
              '|---|---:|---:|---:|---:|---:|---:|---:|']
    for r in reversed(rows[-14:]):
        g = lambda k, kind='n': human(kind, r[k]) if k in r else '—'  # noqa: E731
        lines.append(f'| {r["date"]} | {g("worker_requests")} | {g("worker_cpu_p99_ms")} | {g("r2_bytes", "bytes")} | '
                     f'{g("r2_class_a_month")} | {g("r2_class_b_month")} | {g("fly_out_bytes", "bytes")} | {g("fly_in_bytes", "bytes")} |')
    lines += ['', f'<!-- consumo:{json.dumps({"rows": rows, "warned": hist["warned"]}, separators=(",", ":"))} -->']
    return '\n'.join(lines)


# ------------------------------------------------------------------ GitHub
class GitHub:
    def __init__(self, token, repo, session=None):
        self.s = session or requests.Session()
        self.s.headers.update({'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
        self.base = f'https://api.github.com/repos/{repo}'

    def _ok(self, r):
        r.raise_for_status()
        return r.json()

    def find_issue(self):
        items = self._ok(self.s.get(f'{self.base}/issues', params={'labels': ISSUE_LABEL, 'state': 'all', 'per_page': 20}, timeout=TIMEOUT))
        return next((i for i in items if i.get('title') == ISSUE_TITLE and 'pull_request' not in i), None)

    def create_issue(self, body):
        return self._ok(self.s.post(f'{self.base}/issues', json={'title': ISSUE_TITLE, 'body': body, 'labels': [ISSUE_LABEL]}, timeout=TIMEOUT))

    def update_issue(self, number, body):
        return self._ok(self.s.patch(f'{self.base}/issues/{number}', json={'body': body, 'state': 'open'}, timeout=TIMEOUT))

    def comment(self, number, body):
        return self._ok(self.s.post(f'{self.base}/issues/{number}/comments', json={'body': body}, timeout=TIMEOUT))


def collect(day, env):
    row, notes = {'date': day.isoformat()}, []
    if env.get('R2_ACCESS_KEY_ID'):
        try:
            import boto3
            client = boto3.client('s3', endpoint_url=f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                                  aws_access_key_id=env['R2_ACCESS_KEY_ID'], aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'],
                                  region_name='auto')
            row.update(r2_storage(client, env.get('R2_BUCKET') or 'grilla'))
        except Exception as e:  # noqa: BLE001 — una parte que falla no frena a las demás
            notes.append(f'R2: no se pudo medir el almacenamiento ({type(e).__name__}).')
    if env.get('CLOUDFLARE_ANALYTICS_TOKEN'):
        try:
            row.update(cloudflare(env['CLOUDFLARE_ANALYTICS_TOKEN'], env['R2_ACCOUNT_ID'], day))
        except Exception as e:  # noqa: BLE001
            notes.append(f'Cloudflare: no se pudieron leer las analíticas ({type(e).__name__}).')
    else:
        notes.append('Sin `CLOUDFLARE_ANALYTICS_TOKEN`: faltan los pedidos al Worker y las operaciones de R2.')
    if env.get('FLY_READ_TOKEN'):
        try:
            row.update(fly(env['FLY_READ_TOKEN'], day))
        except Exception as e:  # noqa: BLE001
            notes.append(f'Fly: no se pudieron leer las métricas del relay ({type(e).__name__}).')
    else:
        notes.append('Sin `FLY_READ_TOKEN`: falta el tráfico del relay.')
    return row, notes


def main():
    env = dict(os.environ)
    day = datetime.datetime.now(datetime.timezone.utc).date() - datetime.timedelta(days=1)
    row, notes = collect(day, env)
    gh = GitHub(env['GITHUB_TOKEN'], env['GITHUB_REPOSITORY'])
    issue = gh.find_issue()
    hist = merge_row(load_history(issue['body'] if issue else ''), row)
    warn = new_warnings(hist, row)
    for k, *_ in warn:
        hist['warned'][k] = row['date'][:7]
    body = render(hist, notes)
    issue = gh.update_issue(issue['number'], body) if issue else gh.create_issue(body)
    if warn:
        gh.comment(issue['number'], '⚠️ Pasó el {} % de lo gratis:\n\n{}'.format(
            int(WARN_AT * 100), '\n'.join(f'- {name}: {human(k, used)} de {human(k, cap)} ({used / cap * 100:.0f} %)' for k, name, used, cap in warn)))
    summary = env.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as f:
            f.write(HIST_RE.sub('', body))
    log(f'Listo: issue #{issue["number"]}{" con aviso" if warn else ""}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
