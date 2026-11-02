// Calidad en Canales: la etiqueta (FHD, HD…) va en la misma línea del nombre, no debajo (opción 3).
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

const shots = process.env.SHOTS ?? 'test-results';
const CHANNELS = ['1', '2'];

for (const theme of ['light', 'dark'] as const) {
  test(`calidad en la misma línea del nombre (${theme})`, async ({ page }, info) => {
    await page.addInitScript((t) => localStorage.setItem('grilla_theme', t), theme);
    const res = Object.fromEntries(CHANNELS.map((id, i) => [id, { t: new Date().toISOString(), w: 1920, h: i ? 720 : 1080 }]));
    await fakeWorker(page, { health: { checked: new Date().toISOString(), channels: {}, res, total: 7, relayOk: new Date().toISOString(), tested: 2 } });
    await page.goto('/');
    const names = page.locator('#cards .card .card-name.has-q');
    await expect(names.first()).toBeVisible();
    await expect(names.first().locator('.qtag')).toHaveText('FHD');
    // La etiqueta está en la línea del nombre: misma altura de caja que el nombre.
    const nameBox = await names.first().locator('.cn-text').boundingBox();
    const tagBox = await names.first().locator('.qtag').boundingBox();
    expect(Math.abs((nameBox!.y + nameBox!.height / 2) - (tagBox!.y + tagBox!.height / 2))).toBeLessThan(6);
    await page.screenshot({ path: `${shots}/calidad-canales-${info.project.name}-${theme}.png` });
  });
}
