// Emoji en las categorías, en la edición (ui/perfiles.tsx): el interruptor de la cuenta y el control de tres opciones
// del perfil («Como la cuenta», «Mostrar», «Ocultar»). La regla la aplican el Worker (test/emoji.test.ts) y la app.
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
    const seg = (page: Page) => body(page).getByRole('radiogroup', { name: 'Emoji en las categorías de Chicos' });

    test('el perfil: Como la cuenta por defecto, Mostrar lo guarda y Como la cuenta lo quita', async ({ page }, info) => {
      await page.locator('#tabLinks').click();
      await body(page).locator('.profile-row.sub-row', { hasText: 'Chicos' }).click();
      await expect(page.locator('#linksTitle')).toHaveText('Chicos');
      await expect(seg(page).getByRole('radio', { name: 'Como la cuenta' })).toHaveAttribute('aria-checked', 'true');
      await expect(body(page)).toContainText('Como la cuenta: sin emoji');
      await page.screenshot({ path: `${process.env.SHOTS ?? "test-results"}/emoji-${info.project.name}-${theme}-perfil-cuenta.png` });

      await seg(page).getByRole('radio', { name: 'Mostrar' }).click();
      await expect(seg(page).getByRole('radio', { name: 'Mostrar' })).toHaveAttribute('aria-checked', 'true');
      await expect(body(page)).toContainText('Este perfil lo muestra');
      expect(fake.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/api/cfg/c1/profiles/p2', body: { emoji: true } });
      await page.screenshot({ path: `${process.env.SHOTS ?? "test-results"}/emoji-${info.project.name}-${theme}-perfil-mostrar.png` });

      await seg(page).getByRole('radio', { name: 'Como la cuenta' }).click();
      await expect(seg(page).getByRole('radio', { name: 'Como la cuenta' })).toHaveAttribute('aria-checked', 'true');
      expect(fake.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/api/cfg/c1/profiles/p2', body: { emoji: null } });
    });

    test('la cuenta: el interruptor la prende y se guarda para la cuenta', async ({ page }, info) => {
      await page.locator('#tabLinks').click();
      await body(page).locator('.account-row').first().click();
      const sw = body(page).getByRole('switch', { name: 'Emoji en las categorías de Luis' });
      await expect(sw).not.toBeChecked();
      await sw.click();
      await expect(sw).toBeChecked();
      expect(fake.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/api/cfg/c1/account-emoji', body: { account: '', on: true } });
      await page.screenshot({ path: `${process.env.SHOTS ?? "test-results"}/emoji-${info.project.name}-${theme}-cuenta.png` });
    });
  });
}
