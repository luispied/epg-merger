// Modo «solo ver» de un perfil infantil (ver.tsx, ui/guide.tsx): el Worker manda la programación ya filtrada (lo que no es
// apto llega sin título) y la pantalla lo dibuja como «No disponible en este perfil»: en las tarjetas de canales, en la hoja
// del canal y en la Guía; no entra en la búsqueda, en Próximos ni en Tu plan. Nunca pide la programación pública.
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

const H = Math.floor(Date.now() / 3_600_000) * 3600; // hora UTC en curso
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const MASK = 'No disponible en este perfil';
const sha = (id: string) => createHash('sha1').update(id).digest('hex').slice(0, 16);

const view = {
  name: 'Sofi', kids: true,
  channels: [
    { id: '1', name: 'Canal Dibujos', cat: 'Infantiles', epg: 'g0000000000001.uy', logo: '' },
    { id: '2', name: 'Canal Noticias', cat: 'Infantiles', epg: 'g0000000000002.uy', logo: '' },
    { id: '3', name: 'Canal Sin Datos', cat: 'Infantiles', epg: 'g0000000000003.uy', logo: '' },
  ],
};
// Como lo manda el Worker: lo que no es apto, sin título ni género; las horas, intactas.
const hour = (h: number) => ({
  h, t: h === H ? ['Dibujitos', '', ''] : ['Cuentos del bosque', '', ''], g: h === H ? ['Infantil', '', ''] : ['Educativo', '', ''],
  c: { 'g0000000000001.uy': [h === H ? [-40, 60, 0] : [0, 60, 0]], 'g0000000000002.uy': [h === H ? [-40, 60, 1] : [0, 60, 1]], 'g0000000000003.uy': [h === H ? [-40, 60, 2] : [0, 60, 2]] },
});
const schedule: Record<string, unknown[]> = {
  [sha('g0000000000001.uy')]: [[H - 2400, H + 3600, 'Dibujitos', 'Un perro y sus amigos.', 'Infantil'], [H + 3600, H + 7200, 'Cuentos del bosque', 'Historias para dormir.', 'Educativo']],
  [sha('g0000000000002.uy')]: [[H - 2400, H + 3600, ''], [H + 3600, H + 7200, '']],
  [sha('g0000000000003.uy')]: [[H - 2400, H + 3600, ''], [H + 3600, H + 7200, '']],
};

let errors: string[] = [];
let requests: string[] = [];
let reported: unknown[] = [];

for (const theme of ['light', 'dark'] as const) {
  test.describe(`tema ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      errors = [];
      requests = [];
      reported = [];
      await page.addInitScript((t) => localStorage.setItem('grilla_theme', t), theme);
      await page.clock.setFixedTime(new Date(H * 1000 + 20 * 60_000));
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/api/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        requests.push(path);
        if (r.request().method() !== 'GET' && path !== `/api/view/${CODE}/report` && path !== '/api/ui/again') errors.push(`escribió ${path}`);
        if (path === `/api/view/${CODE}`) return r.fulfill({ json: view });
        if (path === `/api/view/${CODE}/connections`) return r.fulfill({ json: { watching: [] } });
        if (path === `/api/view/${CODE}/habits`) return r.fulfill({ json: { ch: {}, t: {}, no: {}, more: {}, mg: {} } });
        if (path === `/api/view/${CODE}/report`) {
          reported.push(r.request().postDataJSON());
          return r.fulfill({ json: { ok: true } });
        }
        const m = path.match(new RegExp(`^/api/view/${CODE}/hour/(\\d{10})\\.json$`));
        if (m) {
          for (const h of [H, H + 3600]) if (hourKey(h) === m[1]) return r.fulfill({ json: hour(h) });
          return r.fulfill({ status: 404, json: {} });
        }
        const s = path.match(new RegExp(`^/api/view/${CODE}/schedule/([0-9a-f]{16})\\.json$`));
        if (s && schedule[s[1]]) return r.fulfill({ json: schedule[s[1]] });
        if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
        return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
      });
    });

    test.afterEach(() => {
      expect(errors).toEqual([]);
      // La programación pública no se pide nunca: un perfil infantil solo usa las rutas de su código.
      expect(requests.filter((p) => p.startsWith('/api/ui/schedule') || p.startsWith('/api/cfg/'))).toEqual([]);
    });

    test('lo que no es apto se ve como «No disponible en este perfil» en Canales, en la hoja, en la Guía y en Tu plan', async ({ page }, info) => {
      const shot = (name: string) => page.screenshot({ path: `test-results/kids-ver-${info.project.name}-${theme}-${name}.png` });
      await page.goto(`/ver#${CODE}`);
      await expect(page.locator('.vw-row')).toHaveCount(3);
      const rows = page.locator('.vw-row');
      await expect(rows.nth(0)).toContainText('Dibujitos');
      await expect(rows.nth(0)).toContainText('Después: Cuentos del bosque');
      // Lo no apto: el texto fijo en lugar del título, la barra y el «después».
      await expect(rows.nth(1)).toContainText(MASK);
      await expect(rows.nth(1).locator('.np-bar, .vw-bar, .vw-left, .vw-next')).toHaveCount(0);
      await expect(rows.nth(2)).toContainText(MASK);
      await shot('1-canales');

      // La búsqueda no encuentra el texto fijo, solo lo que se ve.
      await page.getByRole('searchbox').fill('perfil');
      await expect(page.locator('.vw-row')).toHaveCount(0);
      await page.getByRole('searchbox').fill('dibujitos');
      await expect(page.locator('.vw-row')).toHaveCount(1);
      await page.getByRole('searchbox').fill('');

      // La hoja de un canal con lo no apto: sin título, sin descripción.
      await rows.nth(1).click();
      const sheet = page.locator('dialog.vw-sheet');
      await expect(sheet.locator('.gd-sh-title')).toHaveText(MASK);
      await expect(sheet.locator('.gd-sh-desc')).toHaveCount(0);
      await expect(sheet.locator('.gd-sh-row span', { hasText: MASK })).toHaveCount(1);
      await shot('2-hoja-oculta');
      await sheet.getByRole('button', { name: 'Lo que dan en la tele no es esto' }).click();
      await expect(sheet).toContainText('le avisamos');
      expect(reported).toEqual([{ id: '2', title: '' }]);
      await page.keyboard.press('Escape');
      // La del canal apto, con su descripción (bajada por el Worker del código).
      await rows.nth(0).click();
      await expect(sheet.locator('.gd-sh-title')).toHaveText('Dibujitos');
      await expect(sheet).toContainText('Un perro y sus amigos.');
      await page.keyboard.press('Escape');

      // La Guía: las celdas no aptas con el texto fijo y la hora.
      await page.getByRole('button', { name: 'Guía' }).click();
      await expect(page.locator('.gd-cell.live')).toHaveCount(3);
      await expect(page.locator('.gd-cell.live.masked')).toHaveCount(2);
      await expect(page.locator('.gd-cell.live.masked').first()).toContainText(MASK);
      await expect(page.locator('.gd-cell.live:not(.masked)')).toContainText('Dibujitos');
      await shot('3-guia');
      await page.locator('.gd-cell.live.masked').first().click();
      const prog = page.locator('dialog.gd-sheet');
      await expect(prog.locator('.gd-sh-title')).toHaveText(MASK);
      await expect(prog.locator('.gd-taste, .gd-sh-genre, .remind-btn, .gd-remind')).toHaveCount(0);
      await expect(prog).toContainText('solo muestra programas de los géneros que eligió quien lo armó');
      await shot('4-hoja-programa');
      await page.keyboard.press('Escape');

      // Próximos: solo lo apto; Tu plan: sin lo que no es apto.
      await page.getByRole('radio', { name: 'Próximos' }).click();
      await expect(page.locator('#guide')).toContainText('Cuentos del bosque');
      await expect(page.locator('#guide .gd-up-row')).toHaveCount(1);
      await expect(page.locator('#guide .gd-up')).not.toContainText(MASK);
      await shot('5-proximos');
      await page.locator('#guide .gd-teaser').click();
      await expect(page.locator('.gd-plan-lead')).toBeVisible();
      await expect(page.locator('#guide .gd-up')).not.toContainText(MASK);
      await shot('6-plan');
    });
  });
}
