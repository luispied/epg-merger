// Tu noche aprende lo que se mira (ui/guide.tsx + habits.ts del Worker), sobre el modo ver: lo de siempre sube al
// plan con el porqué, y «No me interesa» lo saca al momento (y se puede deshacer).
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const NOW = Math.floor(Date.now() / 1000);
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const file = (epg: string) => createHash('sha1').update(epg).digest('hex').slice(0, 16);

const CHANNELS = [
  { id: '1', name: 'Deportes 1', cat: 'Deportes', epg: 'g00000000000001.uy', logo: '' },
  { id: '2', name: 'Infantil 2', cat: 'Infantiles', epg: 'g00000000000002.uy', logo: '' },
];
// Los dos en el aire hasta dentro de 40 minutos: sin hábitos gana el partido en vivo.
const SCHED: Record<string, string> = { [file(CHANNELS[0].epg)]: 'Final del torneo en vivo', [file(CHANNELS[1].epg)]: 'Dibujitos' };
const hours = Array(24).fill(0) as number[];
hours[new Date((NOW - 600) * 1000).getUTCHours()] = 4;
const HABITS = { ch: { [CHANNELS[1].epg]: { n: 6, h: hours } }, t: { dibujitos: { n: 5 } }, no: {} as Record<string, string>, more: {} };

let errors: string[] = [];
let posts: { title: string; kind: string }[] = [];

async function open(page: Page, habits: typeof HABITS | null) {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('grilla_guide_mode', 'plan'));
  let h = habits && structuredClone(habits);
  await page.route('**/api/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === `/api/view/${CODE}`) return r.fulfill({ json: { name: 'Abuela', channels: CHANNELS } });
    if (path === `/api/view/${CODE}/connections`) return r.fulfill({ json: { watching: [] } });
    if (path === `/api/view/${CODE}/habits`) {
      if (!h) return r.fulfill({ status: 404, json: {} });
      if (r.request().method() === 'POST') {
        const body = r.request().postDataJSON() as { title: string; kind: string };
        posts.push(body);
        const k = body.title.toLowerCase();
        delete h.no[k];
        if (body.kind === 'no') h.no[k] = new Date().toISOString();
      }
      return r.fulfill({ json: h });
    }
    if (/^\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/\d{10}\.json$/.test(path)) {
      return path.includes(hourKey(NOW)) ? r.fulfill({ json: { h: Math.floor(NOW / 3600) * 3600, t: [], c: {} } }) : r.fulfill({ status: 404, json: {} });
    }
    const m = /^\/api\/ui\/schedule\/([0-9a-f]{16})\.json$/.exec(path);
    if (m) return r.fulfill({ json: [[NOW - 600, NOW + 2400, SCHED[m[1]] ?? 'Otra cosa']] });
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
  await page.goto(`/ver#${CODE}`);
  await page.getByRole('button', { name: 'Guía' }).click();
}

const first = (page: Page) => page.locator('#guide .gd-plan-list > li').first();

test.beforeEach(() => { errors = []; posts = []; });
test.afterEach(() => { expect(errors).toEqual([]); });

test('sin hábitos, lo mejor de los canales y ningún porqué', async ({ page }) => {
  await open(page, null);
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Final del torneo en vivo');
  await expect(page.locator('#guide .gd-plan-why')).toHaveCount(0);
  await expect(page.locator('#guide .gd-plan-lead')).not.toContainText('solés mirar');
});

test('con hábitos sube lo de siempre con el porqué, y «No me interesa» lo saca y se deshace', async ({ page }, info) => {
  await open(page, HABITS);
  await expect(page.locator('#guide .gd-plan-lead')).toContainText('lo que solés mirar');
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Dibujitos');
  await expect(first(page).locator('.gd-plan-why')).toHaveText('Lo mirás seguido');
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-plan.png` });
  await first(page).locator('.gd-plan-card').click();
  const sheet = page.locator('dialog.gd-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'No me interesa' }).click();
  await expect(sheet.getByRole('button', { name: 'No me interesa' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('.toast')).toContainText('no te lo sugiero más');
  await page.screenshot({ path: `test-results/habitos-${info.project.name}-hoja.png` });
  expect(posts).toEqual([{ title: 'Dibujitos', kind: 'no' }]);
  await sheet.getByRole('button', { name: 'Cerrar el aviso' }).click();
  await sheet.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(first(page).locator('.gd-plan-card .tt')).toHaveText('Final del torneo en vivo');
  await expect(page.locator('#guide .gd-plan-list')).not.toContainText('Dibujitos');
  // Otra vez en la hoja del partido: tocar «No me interesa» dos veces lo deja como estaba.
  await first(page).locator('.gd-plan-card').click();
  await sheet.getByRole('button', { name: 'No me interesa' }).click();
  await expect(sheet.getByRole('button', { name: 'No me interesa' })).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByRole('button', { name: 'Cerrar el aviso' }).click();
  await sheet.getByRole('button', { name: 'No me interesa' }).click();
  await expect(sheet.getByRole('button', { name: 'No me interesa' })).toHaveAttribute('aria-pressed', 'false');
  expect(posts.slice(1).map((p) => p.kind)).toEqual(['no', 'clear']);
});
