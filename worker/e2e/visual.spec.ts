// Prueba de capturas: las pantallas principales en iPhone y escritorio, en claro y oscuro, con la hora congelada y
// datos fijos, para reordenar el CSS (o cambiar tokens) sabiendo que nada cambió a la vista. No hay capturas
// guardadas en el repo: el CI saca las de main y las compara con las del PR en la misma máquina (check-worker.yml,
// trabajo «visual»). Corre solo con VISUAL=1:
//   VISUAL=1 npx playwright test e2e/visual.spec.ts --update-snapshots   (en main: las de referencia)
//   VISUAL=1 npx playwright test e2e/visual.spec.ts                      (con el cambio: compara)
// Con SNAP_DIR las capturas van a esa carpeta (playwright.config.ts).
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

test.skip(!process.env.VISUAL, 'solo con VISUAL=1 (ver el comentario de arriba)');

// Sábado 10/10/2026, 22:20 en Montevideo: de noche, para que «Tu noche» arme el plan.
const NOW = new Date('2026-10-11T01:20:00Z');
const T = NOW.getTime() / 1000;
const H = Math.floor(T / 3600) * 3600;
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const CODE = 'VistaP2Abcdefghijklmno';
test.use({ timezoneId: 'America/Montevideo' });

// La programación de cada canal con guía: algo en el aire, algo corto, una película y un partido en vivo.
const sched = (seed: number): [number, number, string, string?][] => {
  const titles = [['Noticiero central', 'Las noticias del día, con el pronóstico.'], ['Fútbol: Peñarol vs. Nacional en vivo', 'El clásico, desde el Centenario.'],
    ['Película: El secreto de sus ojos', 'Un clásico del cine argentino.'], ['Dibujitos animados'], ['Documental: Océanos'], ['Resumen deportivo']];
  const out: [number, number, string, string?][] = [];
  let s = H - 3600 - seed * 600;
  for (let k = 0; s < H + 30 * 3600; k++) {
    const len = (k + seed) % 4 === 1 ? 300 : 3600 + ((k + seed) % 3) * 1800;
    const [t, d] = titles[(k + seed) % titles.length];
    out.push(d ? [s, s + len, t, d] : [s, s + len, t]);
    s += len;
  }
  return out;
};

// Los canales con guía del Worker de prueba (fake-worker.ts) y del modo ver de abajo.
const EPGS = ['g00000000000001.ar', 'g00000000000002.ar', 'g00000000000003.ar', 'g00000000000001.uy', 'g00000000000002.uy',
  'g00000000000003.uy', 'g00000000000005.uy'];
const fileOf = (epg: string) => createHash('sha1').update(epg).digest('hex').slice(0, 16);

/** El índice por hora (lo que usa Próximos): {h, t: títulos, c: {epg: [[inicio, fin, título] en minutos desde h]}}. */
function hourIndex(h: number) {
  const t: string[] = [];
  const c: Record<string, [number, number, number][]> = {};
  EPGS.forEach((epg, i) => {
    for (const [s, e, title] of sched(i)) {
      if (e <= h || s >= h + 3600) continue;
      if (!t.includes(title)) t.push(title);
      (c[epg] ??= []).push([(s - h) / 60, (e - h) / 60, t.indexOf(title)]);
    }
  });
  return { h, t, c };
}

async function schedules(page: Page) {
  await page.route('**/api/ui/**', async (r) => {
    const path = new URL(r.request().url()).pathname;
    const m = path.match(/^\/api\/ui\/schedule\/hour\/(\d{10})(-d)?\.json$/);
    if (m) {
      const h = [...Array(32).keys()].map((k) => H - 3600 + k * 3600).find((x) => hourKey(x) === m[1]);
      if (h === undefined || m[2]) return r.fulfill({ status: 404, json: {} });
      return r.fulfill({ json: hourIndex(h) });
    }
    const f = path.match(/^\/api\/ui\/schedule\/([0-9a-f]{16})\.json$/);
    if (f) {
      const i = EPGS.findIndex((e) => fileOf(e) === f[1]);
      return i < 0 ? r.fulfill({ status: 404, json: {} }) : r.fulfill({ json: sched(i) });
    }
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
    return r.fulfill({ status: 404, json: {} });
  });
}

async function setup(page: Page, theme: string) {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript((t) => { localStorage.setItem('grilla_theme', t); localStorage.setItem('grilla_seen_version', '99.0.0'); }, theme);
  await page.emulateMedia({ colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' });
}

// Suave: si una pantalla cambió, el test sigue y compara las demás.
const shot = (page: Page, name: string) => expect.soft(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 });

for (const theme of ['light', 'dark']) {
  test.describe(theme === 'light' ? 'claro' : 'oscuro', () => {
    test('bienvenida', async ({ page }) => {
      await setup(page, theme);
      await page.route('**/api/**', (r) => r.fulfill({ status: 502, json: { error: 'sin red' } }));
      await page.goto('/');
      await expect(page.locator('#onboarding')).toBeVisible();
      await shot(page, `${theme}-bienvenida`);
    });

    test('editor: canales, canal, configuración, categorías y perfil', async ({ page }) => {
      await setup(page, theme);
      await fakeWorker(page);
      await schedules(page);
      await page.goto('/');
      await expect(page.locator('#cards .card').first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await shot(page, `${theme}-canales`);
      await page.locator('#cards .card').first().click();
      await expect(page.locator('#channelDialog')).toBeVisible();
      await shot(page, `${theme}-canal`);
      await page.keyboard.press('Escape');
      await page.locator('#settingsBtn').click();
      await expect(page.locator('#settingsDialog')).toBeVisible();
      await shot(page, `${theme}-configuracion`);
      await page.keyboard.press('Escape');
      await page.locator('#categoriesBtn').click();
      await expect(page.locator('#categoriesDialog')).toBeVisible();
      await shot(page, `${theme}-categorias`);
      await page.locator('#tabLinks').click();
      await expect(page.locator('#linksDialog')).toBeVisible();
      await shot(page, `${theme}-perfil`);
    });

    test('editor: la Guía en sus tres modos', async ({ page }) => {
      await setup(page, theme);
      await fakeWorker(page);
      await schedules(page);
      await page.goto('/');
      await expect(page.locator('#cards .card').first()).toBeVisible();
      await page.locator('#tabGuide').click();
      await expect(page.locator('#guide .gd-cell').first()).toBeVisible();
      await shot(page, `${theme}-guia-grilla`);
      await page.getByRole('radio', { name: 'Próximos' }).click();
      await expect(page.locator('#guide .gd-up-row').first()).toBeVisible();
      await shot(page, `${theme}-guia-proximos`);
      await page.getByRole('radio', { name: /^Tu / }).click();
      await expect(page.locator('#guide .gd-plan-list, #guide .gd-up-empty').first()).toBeVisible();
      await shot(page, `${theme}-guia-tu-noche`);
      await page.getByRole('radio', { name: 'Grilla' }).click();
      await page.locator('#guide .gd-cell.live').first().click();
      await expect(page.locator('dialog.gd-sheet')).toBeVisible();
      await shot(page, `${theme}-guia-programa`);
    });

    test('modo ver: canales y Guía', async ({ page }) => {
      await setup(page, theme);
      await schedules(page);
      const channels = [['ESPN', 'Deportes'], ['Fox Sports', 'Deportes'], ['CNN', 'Noticias'], ['TN', 'Noticias'], ['Cartoon Network', 'Infantiles']]
        .map(([name, cat], i) => ({ id: String(i + 1), name, cat, epg: i === 3 ? null : `g0000000000000${i + 1}.uy`, logo: '' }));
      await page.route('**/api/view/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path === `/api/view/${CODE}`) return r.fulfill({ json: { name: 'Abuela', channels } });
        if (path === `/api/view/${CODE}/connections`) return r.fulfill({ json: { watching: [{ name: 'TV del living', channel: 'CNN', t: new Date(NOW.getTime() - 20 * 60_000).toISOString() }], inUse: 1, max: 2 } });
        return r.fulfill({ status: 404, json: {} });
      });
      await page.goto(`/ver#${CODE}`);
      await expect(page.locator('.vw-row').first()).toBeVisible();
      await shot(page, `${theme}-ver-canales`);
      await page.getByRole('button', { name: 'Guía' }).click();
      await expect(page.locator('#guide .gd-cell').first()).toBeVisible();
      await shot(page, `${theme}-ver-guia`);
    });
  });
}
