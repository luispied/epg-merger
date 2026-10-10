// Un Worker de mentira para los tests de humo: una configuración Xtream con pocos canales, una cuenta con dos perfiles
// y un link, guardados en memoria. Lo que la app pide y acá no está responde 404, como un Worker sin esos datos.
import { readFileSync } from 'node:fs';
import type { Page, Request } from '@playwright/test';

const rules = JSON.parse(readFileSync(new URL('../../matching_rules.json', import.meta.url), 'utf-8'));
const day = 86_400_000;

export interface Fake {
  /** Los pedidos que cambian algo (método, ruta y cuerpo), en orden. */
  writes: { method: string; path: string; body: unknown }[];
  profiles: { id: string; name: string; account?: string; filter?: { groups: string[]; channels: string[]; only?: boolean } | null }[];
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

/** Deja la app con una configuración guardada en este navegador y contesta /api como el Worker. */
export async function fakeWorker(page: Page): Promise<Fake> {
  const fake: Fake = {
    writes: [],
    profiles: [
      { id: 'p1', name: 'Luis' },
      { id: 'p2', name: 'Chicos', filter: { groups: ['Deportes'], channels: [] } },
    ],
  };
  const devices = [{
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
    if (path === '/api/cfg/c1/list') return json({ channels });
    if (path === '/api/cfg/c1/devices') return json({ devices, profiles: fake.profiles, mainName: 'Luis' });
    if (path === '/api/cfg/c1/accounts') {
      return json({ accounts: { ak1: { expires: new Date(Date.now() + 20.5 * day).toISOString(), maxConnections: 2, activeConnections: 1 } } });
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
    const m = path.match(/^\/api\/cfg\/c1\/profiles\/(\w+)$/);
    if (m && method === 'PUT') {
      const p = fake.profiles.find((x) => x.id === m[1]);
      if (!p) return json({ error: 'no existe' }, 404);
      Object.assign(p, req.postDataJSON());
      return json({});
    }
    return json({ error: 'no está en el Worker de prueba' }, 404);
  };
  await page.route('**/api/**', (route) => route.fulfill(routes(route.request())));
  return fake;
}
