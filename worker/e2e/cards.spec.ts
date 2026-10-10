// Humo de las tarjetas de arriba de la lista (ui/cards.tsx): la de los links recién armados y, al descartarla, la de los
// atajos. Las dos se descartan una sola vez.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  await fakeWorker(page);
  // Una lista recién armada: la tarjeta de los links está pendiente.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('cards')) return;
    sessionStorage.setItem('cards', '1');
    localStorage.setItem('grilla_links_card_c1', '1');
  });
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('la tarjeta de los links copia, abre el QR y se descarta', async ({ page }) => {
  const card = page.locator('#linksCard');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Tu lista está lista');
  await expect(page.locator('#tipCard')).toBeHidden();

  const copy = card.getByRole('button', { name: 'Copiar playlist' });
  await copy.click();
  await expect(card.getByRole('button', { name: 'Copiado' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Copiar guía' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Copiar playlist' })).toBeVisible({ timeout: 4000 });

  await card.getByRole('button', { name: 'Ver código QR y otras formas de compartir' }).click();
  await expect(page.locator('#linksDialog')).toBeVisible();
  await expect(page.locator('#linksBody .sub-title')).toHaveText('TV del living');
  await page.keyboard.press('Escape');
  await expect(page.locator('#linksDialog')).toBeHidden();

  // Al descartarla aparece la de los atajos, y ninguna vuelve al recargar.
  await card.getByRole('button', { name: 'Descartar' }).click();
  await expect(card).toBeHidden();
  const tip = page.locator('#tipCard');
  await expect(tip).toContainText('Atajos');
  await tip.getByRole('button', { name: 'Entendido' }).click();
  await expect(tip).toBeHidden();
  await page.reload();
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(card).toBeHidden();
  await expect(tip).toBeHidden();
});
