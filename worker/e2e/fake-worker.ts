// Un Worker de mentira para los tests de humo: una configuración Xtream con pocos canales, una cuenta con dos perfiles
// y un link, guardados en memoria. Lo que la app pide y acá no está responde 404, como un Worker sin esos datos.
import { readFileSync } from 'node:fs';
import type { Page, Request } from '@playwright/test';

const rules = JSON.parse(readFileSync(new URL('../../matching_rules.json', import.meta.url), 'utf-8'));
const day = 86_400_000;

export interface Fake {
  /** Los pedidos que cambian algo (método, ruta y cuerpo), en orden. */
  writes: { method: string; path: string; body: unknown }[];
  /** Canales marcados desde el modo ver («la guía no coincide»). */
  reports: { id: string; name: string; epg: string | null; title?: string; by: string; at: string }[];
  profiles: { id: string; name: string; account?: string; filter?: { groups: string[]; channels: string[]; only?: boolean } | null; view?: string; kids?: { genres: string[] } }[];
}

const channels = [
  ['ESPN', 'Deportes'], ['Fox Sports', 'Deportes'], ['TyC Sports', 'Deportes'],
  ['CNN', 'Noticias'], ['TN', 'Noticias'],
  ['Disney Channel', 'Infantiles'], ['Cartoon Network', 'Infantiles'],
].map(([name, category], i) => ({ name, category, id: String(i + 1), ext: 'ts', icon: '', epgId: null }));

// La guía: dos canales que la lista encuentra sola (ESPN y CNN) y uno para buscar a mano.
const guide = [
  { id: 'g00000000000001.ar', k: 'k1', source: 's1', names: ['ESPN'], icon: '' },
  { id: 'g00000000000002.ar', k: 'k2', source: 's1', names: ['CNN'], icon: '' },
  { id: 'g00000000000003.ar', k: 'k3', source: 's1', names: ['Canal Rural'], icon: '' },
];

/** Deja la app con una configuración guardada en este navegador y contesta /api como el Worker. `extra` suma canales
 *  ([nombre, categoría]) a la lista del proveedor; `health` es lo que devuelve la prueba de canales. */
export async function fakeWorker(page: Page, opts: { extra?: string[][]; health?: Record<string, unknown>; devices?: Record<string, unknown>[]; accounts?: Record<string, unknown>; history?: Record<string, unknown>; hist?: Record<string, { t: string; ch: string; p?: string }[]>; run?: Record<string, unknown> } = {}): Promise<Fake> {
  const list = [...channels, ...(opts.extra ?? []).map(([name, category], i) => ({ name, category, id: String(100 + i), ext: 'ts', icon: '', epgId: null }))];
  const fake: Fake = {
    writes: [],
    reports: [],
    profiles: [
      { id: 'p1', name: 'Luis' },
      { id: 'p2', name: 'Chicos', filter: { groups: ['Deportes'], channels: [] } },
    ],
  };
  const devices = opts.devices ?? [{
    code: 'd1', name: 'TV del living', active: true, lastUsed: new Date(Date.now() - 3_600_000).toISOString(), accountKey: 'ak1', profile: 'p1', lastPlay: { t: new Date(Date.now() - 20 * 60_000).toISOString(), ch: '4' },
    playlistUrl: 'https://grilla.test/p/abc123', epgUrl: 'https://grilla.test/e/abc123',
  }];
  const cfg = {
    version: 1, provider: { type: 'xtream', servers: ['http://proveedor.test:8080'] }, channels: {}, mainName: 'Luis',
    groups: { order: ['Deportes', 'Noticias', 'Infantiles'], hidden: [] },
  };
  await page.addInitScript(() => {
    if (sessionStorage.getItem('fake-worker')) return; // solo la primera vez: después la app guarda lo suyo
    sessionStorage.setItem('fake-worker', '1');
    localStorage.setItem('grilla_web_v1', JSON.stringify({ cfgId: 'c1', editKey: 'k1' }));
    localStorage.setItem('grilla_home_v1', JSON.stringify({ configs: [{ cfgId: 'c1', editKey: 'k1', name: 'Mi proveedor' }] }));
  });
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const routes = (req: Request) => {
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (method !== 'GET') fake.writes.push({ method, path, body: req.postDataJSON() });
    if (path === '/api/guide/index.json') return json({ matching_rules: rules, sources: { s1: { country: 'ar', priority: 0 } }, channels: guide });
    if (path === '/api/cfg/c1') return method === 'GET' ? json(cfg) : json({});
    if (path === '/api/cfg/c1/list') return json({ channels: list });
    if (path === '/api/cfg/c1/devices') return json({ devices, profiles: fake.profiles, mainName: 'Luis' });
    const hist = /^\/api\/cfg\/c1\/devices\/([^/]+)\/historial$/.exec(path);
    if (hist) return json({ items: opts.hist?.[hist[1]] ?? [] });
    if (path === '/api/cfg/c1/accounts') {
      return json({ accounts: opts.accounts ?? { ak1: { expires: new Date(Date.now() + 20.5 * day).toISOString(), maxConnections: 2, activeConnections: 1 } }, history: opts.history ?? {} });
    }
    if (path === '/api/cfg/c1/status') return json({ guideUpToDate: true, guide: '2026-10-10T12:00:00Z', autoRefresh: true });
    if (path === '/api/cfg/c1/refresh') return json({ started: true });
    if (path === '/api/push/key') return json({ key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' });
    if (path === '/api/cfg/c1/profiles' && method === 'POST') {
      const body = req.postDataJSON() as { name: string; account?: string };
      const profile = { id: `p${fake.profiles.length + 1}`, ...body };
      fake.profiles.push(profile);
      return json({ profile });
    }
    // El hogar: se crea con id y clave fijos; lo que sube viene cifrado y no se mira.
    if (path === '/api/home' && method === 'POST') return json({ homeId: 'Hogar0123456789abcd', homeKey: 'Clave0123456789abcdefgh' });
    if (path.startsWith('/api/home/') && method === 'PUT') return json({});
    if (path === '/api/cfg/c1/health' && opts.health) return json(opts.health);
    if (path === '/api/cfg/c1/health/run' && method === 'DELETE') return json({ stopped: true });
    if (path === '/api/cfg/c1/health/run' && method === 'POST') return json(opts.run ?? { started: true, requested: new Date().toISOString() });
    if (path === '/api/cfg/c1/reports') return json({ items: fake.reports });
    const rp = path.match(/^\/api\/cfg\/c1\/reports\/(\w+)$/);
    if (rp && method === 'DELETE') {
      fake.reports = fake.reports.filter((r) => r.id !== rp[1]);
      return json({ ok: true });
    }
    const v = path.match(/^\/api\/cfg\/c1\/profiles\/(\w+)\/view$/);
    if (v) {
      const p = fake.profiles.find((x) => x.id === v[1]);
      if (!p) return json({ error: 'no existe' }, 404);
      if (method === 'DELETE') { delete p.view; return json({ ok: true }); }
      p.view ??= `Vista${p.id}Abcdefghijklmnop`.slice(0, 22);
      return json({ code: p.view });
    }
    // Qué se oculta en un perfil infantil (src/kids.ts → kidsReport).
    const k = path.match(/^\/api\/cfg\/c1\/profiles\/(\w+)\/kids$/);
    if (k) {
      return fake.profiles.find((x) => x.id === k[1])?.kids
        ? json({ hours: 6, shown: 5, hidden: 7, by: [
          { genre: '', n: 4, sample: ['Misterio en la casa', 'Capítulo 12', 'Especial'] },
          { genre: 'Película', n: 2, sample: ['Terror en la noche', 'La gran fuga'] },
          { genre: 'Noticias', n: 1, sample: ['Noticiero central'] },
        ] })
        : json({ error: 'este perfil no es infantil' }, 404);
    }
    const m = path.match(/^\/api\/cfg\/c1\/profiles\/(\w+)$/);
    if (m && method === 'PUT') {
      const p = fake.profiles.find((x) => x.id === m[1]);
      if (!p) return json({ error: 'no existe' }, 404);
      const { kids, ...rest } = req.postDataJSON() as { kids?: { genres: string[] } | null };
      Object.assign(p, rest);
      // Como el Worker: Infantil y Educativo entran siempre; null lo quita.
      if (kids === null) delete p.kids;
      else if (kids) p.kids = { genres: ['Infantil', 'Educativo', ...kids.genres.filter((g) => ['Documental', 'Cocina', 'Música', 'Deportes', 'Estilo de vida'].includes(g))] };
      return json({});
    }
    return json({ error: 'no está en el Worker de prueba' }, 404);
  };
  await page.route('**/api/**', (route) => route.fulfill(routes(route.request())));
  return fake;
}
