// Calidad en el nombre, en la edición (ui/perfiles.tsx): el interruptor de la cuenta y el del perfil, que sigue a la
// cuenta como el emoji. La playlist la arma el Worker (test/calidad.test.ts).
import { expect, test, type Page } from '@playwright/test';
import { fakeWorker, type Fake } from './fake-worker.ts';

let errors: string[] = [];
let fake: Fake;

for (const theme of ['light', 'dark'] as const) {
  test.describe(`tema ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
      await page.addInitScript((t) => localStorage.setItem('grilla_theme', t), theme);
      fake = await fakeWorker(page);
      await page.goto('/');
      await expect(page.locator('#cards .card').first()).toBeVisible();
    });

    test.afterEach(() => {
      expect(errors).toEqual([]);
    });

    const body = (page: Page) => page.locator('#linksBody');
    const shots = process.env.SHOTS ?? 'test-results';

    test('el perfil sigue a la cuenta; distinto queda propio, y lo igual a la cuenta vuelve a seguirla', async ({ page }, info) => {
      await page.locator('#tabLinks').click();
      await body(page).locator('.profile-row.sub-row', { hasText: 'Chicos' }).click();
      const sw = body(page).getByRole('switch', { name: 'Calidad en el nombre de Chicos' });
      await expect(sw).not.toBeChecked();
      await expect(body(page)).toContainText('Igual que la cuenta: sin calidad');
      await page.screenshot({ path: `${shots}/calidad-${info.project.name}-${theme}-perfil.png` });

      await sw.click();
      await expect(sw).toBeChecked();
      await expect(body(page)).toContainText('Distinto de la cuenta: con calidad');
      expect(fake.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/api/cfg/c1/profiles/p2', body: { quality: true } });

      await sw.click();
      await expect(sw).not.toBeChecked();
      await expect(body(page)).toContainText('Igual que la cuenta: sin calidad');
      expect(fake.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/api/cfg/c1/profiles/p2', body: { quality: null } });
    });

    test('la cuenta: el interruptor la prende y se guarda para la cuenta', async ({ page }, info) => {
      await page.locator('#tabLinks').click();
      await body(page).locator('.account-row').first().click();
      const sw = body(page).getByRole('switch', { name: 'Calidad en el nombre de Luis' });
      await expect(sw).not.toBeChecked();
      await sw.click();
      await expect(sw).toBeChecked();
      expect(fake.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/api/cfg/c1/account-quality', body: { account: '', on: true } });
      await page.screenshot({ path: `${shots}/calidad-${info.project.name}-${theme}-cuenta.png` });
    });
  });
}
