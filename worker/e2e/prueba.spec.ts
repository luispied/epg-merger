// La prueba de canales caídos en curso: la franja fija arriba de la lista («Probando 50 de 180»), «Detener» y el aviso
// del final. Los avisos van arriba (centrados en el iPhone, a la derecha en el escritorio), en la capa de arriba de todo.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

test('franja de la prueba: avance, «Detener» y el aviso arriba', async ({ page }, info) => {
  const health: Record<string, unknown> = { channels: {}, total: 180, checked: ago(30), relayOk: ago(30), requested: ago(0.05), progress: { done: 50, total: 180, down: 3 } };
  const fake = await fakeWorker(page, { health });
  await page.goto('/');
  const strip = page.locator('#probeStrip');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('Probando 50 de 180');
  await expect(strip).toContainText('3 caídos');
  await page.screenshot({ path: `test-results/prueba-${info.project.name}-franja.png` });
  await strip.getByRole('button', { name: 'Detener' }).click();
  const toast = page.locator('.toasts .toast');
  await expect(toast).toContainText('Prueba detenida');
  await expect(strip).toBeHidden();
  expect(fake.writes.some((w) => w.method === 'DELETE' && w.path === '/api/cfg/c1/health/run')).toBe(true);
  // Arriba: debajo de la isla en el iPhone; arriba a la derecha en el escritorio.
  const box = (await toast.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.y).toBeLessThan(100);
  if (info.project.name === 'escritorio') expect(box.x).toBeGreaterThan(vp.width / 2);
  else expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(4);
  // En la capa de arriba de todo (popover): no lo tapa ninguna página, hoja ni barra.
  expect(await page.locator('#toasts').evaluate((el) => el.matches(':popover-open'))).toBe(true);
  await page.screenshot({ path: `test-results/prueba-${info.project.name}-detenida.png` });
});

test('franja de la prueba: en espera sin número y, al terminar, «Listo» con «Ver»', async ({ page }) => {
  await page.clock.install();
  const health: Record<string, unknown> = { channels: {}, total: 3, checked: ago(30), relayOk: ago(30), requested: ago(0.05) };
  await fakeWorker(page, { health });
  await page.goto('/');
  const strip = page.locator('#probeStrip');
  await expect(strip).toContainText('Prueba de canales en espera');
  await expect(page.locator('#probeBar')).toHaveClass(/wait/);
  // Termina: dos canales caídos (fallaron dos veces seguidas).
  const now = new Date().toISOString();
  Object.assign(health, { checked: now, tested: 3, requested: undefined, channels: { 1: { t: now, ok: false, fails: 2 }, 2: { t: now, ok: false, fails: 3 }, 3: { t: now, ok: true, fails: 0 } } });
  await page.clock.runFor(16_000);
  await expect(strip).toBeHidden();
  const toast = page.locator('.toasts .toast');
  await expect(toast).toContainText('Listo: 2 canales caídos entre 3 probados');
  await toast.getByRole('button', { name: 'Ver' }).click();
  await expect(page.locator('#filterTabs [data-filter="caidos"]')).toHaveAttribute('aria-pressed', 'true');
});
