// Hojas (ui/sheet.ts): se van con una animación (Esc o la ✕) y en el celular se bajan arrastrando el encabezado.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

test.beforeEach(async ({ page }) => {
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
});

const settings = (page: import('@playwright/test').Page) => page.locator('#helpDialog');

test('Esc y la ✕ cierran con una animación de salida', async ({ page }) => {
  const help = page.locator('#helpDialog');
  await page.locator('#helpTopBtn').click();
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  // Mientras sale, sigue abierta con la clase de salida; después se cierra.
  await expect(help).toHaveClass(/\bclosing\b/);
  await expect(help).toBeHidden();
  await expect(help).not.toHaveClass(/\bclosing\b/);
  await page.locator('#helpTopBtn').click();
  await help.getByRole('button', { name: 'Cerrar' }).first().click();
  await expect(help).toHaveClass(/\bclosing\b/);
  await expect(help).toBeHidden();
});

test('en el celular, arrastrar el encabezado hacia abajo cierra la hoja de ayuda; poco, vuelve a su lugar', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone', 'el arrastre es de la hoja inferior del celular');
  await page.locator('#helpTopBtn').click();
  const title = settings(page).locator('#helpTitle');
  await expect(title).toBeVisible();
  // La hoja sube desde abajo: se mide cuando terminó de subir.
  await page.waitForFunction(() => document.getElementById('helpDialog')!.getAnimations().every((a) => a.playState === 'finished'));
  const box = (await title.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // Poco: vuelve.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 8 });
  await page.mouse.up();
  await expect(settings(page)).toBeVisible();
  await expect(settings(page)).not.toHaveClass(/\bclosing\b/);
  // Lo suficiente: se cierra.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 220, { steps: 12 });
  await page.mouse.up();
  await expect(settings(page)).toBeHidden();
});
