// La píldora de selección de la barra de abajo (ui/tabbar.ts): se desliza hasta la pestaña elegida, en la edición.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(page.locator('#tabbar.placed')).toHaveCount(1);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

// El centro de una caja: la píldora se compara con la pestaña por el centro (en el celular se mueve en x, en el
// escritorio en y).
const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test('la píldora queda sobre la pestaña elegida y se desliza hasta la nueva', async ({ page }) => {
  const boxOf = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const home = center(await boxOf('#tabHome'));
  const pill0 = center(await boxOf('#tabbar .tab-pill'));
  expect(dist(pill0, home)).toBeLessThan(1.5);
  await expect(page.locator('#tabHome')).toHaveClass(/active/);

  const guide = center(await boxOf('#tabGuide'));
  await page.locator('#tabGuide').click();
  // A mitad del recorrido la píldora está entre las dos pestañas: se ve que viaja.
  await page.waitForTimeout(90);
  const mid = center(await boxOf('#tabbar .tab-pill'));
  expect(dist(mid, home)).toBeGreaterThan(2);
  expect(dist(mid, guide)).toBeGreaterThan(2);
  // Al final queda sobre la Guía.
  await expect.poll(async () => dist(center(await boxOf('#tabbar .tab-pill')), guide)).toBeLessThan(1.5);
  await expect(page.locator('#tabbar .tab-pill')).toHaveCSS('opacity', '1');
});
