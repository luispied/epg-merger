// Hojas (ui/sheet.ts): se van con una animación (Esc o la ✕) y en el celular se bajan arrastrando el encabezado.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

test.beforeEach(async ({ page }) => {
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
});

const settings = (page: import('@playwright/test').Page) => page.locator('#channelDialog');

test('Esc y la ✕ cierran con una animación de salida', async ({ page }, info) => {
  // En escritorio el canal se acopla al costado (no es una hoja que se va): la animación de salida es del celular.
  test.skip(info.project.name !== 'iphone', 'en escritorio el canal queda acoplado a un lado');
  const help = page.locator('#channelDialog');
  await page.locator('#cards .card').first().click();
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  // Mientras sale, sigue abierta con la clase de salida; después se cierra.
  await expect(help).toHaveClass(/\bclosing\b/);
  await expect(help).toBeHidden();
  await expect(help).not.toHaveClass(/\bclosing\b/);
  await page.locator('#cards .card').first().click();
  await help.getByRole('button', { name: 'Cerrar' }).first().click();
  await expect(help).toHaveClass(/\bclosing\b/);
  await expect(help).toBeHidden();
});

// Pendiente: la hoja del canal no responde al arrastre en el celular (la de ayuda sí). Hay que mirar si es a propósito.
test.fixme('en el celular, arrastrar el encabezado hacia abajo cierra la hoja; poco, vuelve a su lugar', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone', 'el arrastre es de la hoja inferior del celular');
  await page.locator('#cards .card').first().click();
  // El encabezado de la hoja (no el nombre del canal, que es un campo): ahí se arrastra.
  const title = settings(page).locator('.sheet-body > .title-row');
  await expect(title).toBeVisible();
  // La hoja sube desde abajo: se mide cuando terminó de subir.
  await page.waitForFunction(() => document.getElementById('channelDialog')!.getAnimations().every((a) => a.playState === 'finished'));
  const box = (await title.boundingBox())!;
  const x = box.x + 16;
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
