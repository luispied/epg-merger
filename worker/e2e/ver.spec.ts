// Humo del modo «solo ver» (ver.tsx): con el código en la dirección, muestra los canales del perfil con lo que dan
// ahora, la hoja de un canal y la Guía sin nada para editar; un link quitado dice que ya no funciona.
import { expect, test } from '@playwright/test';

const H = Math.floor(Date.now() / 3_600_000) * 3600; // hora UTC en curso
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';

const view = {
  name: 'Abuela',
  channels: [
    { name: 'Canal Uno', cat: 'Noticias', epg: 'g0000000000001.uy', logo: '' },
    { name: 'Canal Dos', cat: 'Noticias', epg: 'g0000000000002.uy', logo: '' },
    { name: 'Cine Clásico', cat: 'Películas', epg: 'g0000000000003.uy', logo: '' },
    { name: 'Canal Local', cat: 'Películas', epg: null, logo: '', quiet: true },
  ],
};
// Cada canal: un programa en el aire y otro la hora siguiente.
const titles: Record<string, [string, string]> = {
  'g0000000000001.uy': ['Noticiero central', 'Pronóstico del tiempo'],
  'g0000000000002.uy': ['Almorzando con amigos', 'La tarde es nuestra'],
  'g0000000000003.uy': ['Casablanca', 'Lo que el viento se llevó'],
};
const hour = (h: number) => ({
  h, t: Object.values(titles).map((t) => t[h === H ? 0 : 1]),
  c: Object.fromEntries(Object.keys(titles).map((id, k) => [id, [h === H ? [-40, 60, k] : [0, 60, k]]])),
});

let errors: string[] = [];
let gone = false;

test.beforeEach(async ({ page }) => {
  errors = [];
  gone = false;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    // El modo ver no escribe nada.
    if (r.request().method() !== 'GET' && path !== '/api/ui/again') errors.push(`escribió ${path}`);
    if (path === `/api/view/${CODE}`) return gone ? r.fulfill({ status: 404, json: { error: 'no' } }) : r.fulfill({ json: view });
    const m = path.match(/^\/api\/ui\/schedule\/hour\/(\d{10})\.json$/);
    if (m) {
      for (const h of [H, H + 3600]) if (hourKey(h) === m[1]) return r.fulfill({ json: hour(h) });
      return r.fulfill({ status: 404, json: {} });
    }
    if (path.startsWith('/api/ui/schedule/')) {
      return r.fulfill({ json: [[H - 2400, H + 3600, 'Noticiero central', 'Las noticias del día, con todo lo que pasó.'], [H + 3600, H + 7200, 'Pronóstico del tiempo'], [H + 7200, H + 9000, 'Deportes al cierre']] });
    }
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('los canales del perfil con lo que dan ahora, la hoja del canal y la Guía sin editar', async ({ page }, info) => {
  await page.goto(`/ver#${CODE}`);
  await expect(page.locator('.vw-who')).toContainText('Abuela');
  await expect(page.locator('.vw-row')).toHaveCount(4);
  await expect(page.locator('.vw-cat')).toHaveText(['Noticias', 'Películas']);
  const first = page.locator('.vw-row').first();
  await expect(first).toContainText('Noticiero central');
  await expect(first).toContainText('Después: Pronóstico del tiempo');
  await expect(page.locator('.vw-row').nth(3)).toContainText('Sin guía');
  await page.screenshot({ path: `test-results/ver-${info.project.name}-canales.png` });
  // Buscar por programa.
  await page.getByRole('searchbox').fill('casablanca');
  await expect(page.locator('.vw-row')).toHaveCount(1);
  await expect(page.locator('.vw-row')).toContainText('Cine Clásico');
  await page.getByRole('searchbox').fill('');
  // La hoja del canal: lo de ahora con su descripción y lo que viene, sin avisos.
  await first.click();
  const sheet = page.locator('dialog.vw-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Las noticias del día');
  await expect(sheet).toContainText('Deportes al cierre');
  await expect(sheet.locator('.remind-btn, .gd-remind')).toHaveCount(0);
  await page.screenshot({ path: `test-results/ver-${info.project.name}-canal.png` });
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // La Guía: los programas, sin «Cambiar la guía» ni avisos.
  await page.getByRole('button', { name: 'Guía' }).click();
  await expect(page.locator('#guide')).toBeVisible();
  await expect(page.locator('.gd-cell.live')).toHaveCount(3);
  await expect(page.locator('.gd-cell.gap.quiet')).toContainText('Este canal no tiene programación');
  await page.screenshot({ path: `test-results/ver-${info.project.name}-guia.png` });
  await page.locator('.gd-cell.live').first().click();
  const prog = page.locator('dialog.gd-sheet');
  await expect(prog).toContainText('En el aire');
  await expect(prog.locator('.gd-sh-fix')).toHaveCount(0);
  await expect(prog.locator('.remind-btn, .gd-remind')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Próximos y «Tu noche» también, sin avisos.
  await page.getByRole('radio', { name: 'Próximos' }).click();
  await expect(page.locator('#guide')).toContainText('Pronóstico del tiempo');
  await page.getByRole('radio', { name: /^Tu (mañana|tarde|noche|madrugada)$/ }).click();
  await expect(page.locator('#guide .remind-btn, #guide .gd-remind')).toHaveCount(0);
});

test('un link quitado o sin código dice qué hacer', async ({ page }, info) => {
  gone = true;
  await page.goto(`/ver#${CODE}`);
  await expect(page.locator('.vw-problem')).toContainText('Este link ya no funciona');
  await page.screenshot({ path: `test-results/ver-${info.project.name}-quitado.png` });
  await page.evaluate(() => localStorage.clear());
  await page.goto('/ver');
  await expect(page.locator('.vw-problem')).toContainText('Falta el código');
});
