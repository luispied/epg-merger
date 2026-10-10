// Humo del aviso de relay caído (renderProfileNotice en ui/perfiles.tsx y la fila «Canales caídos»): si el servicio que
// habla con el proveedor deja de responder, la lista vieja y la prueba sin hacer se avisan arriba de los canales.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

test('relay caído: aviso arriba de los canales y la fila de caídos dice desde cuándo', async ({ page }, info) => {
  await fakeWorker(page, { health: {
    channels: {}, total: 7, checked: ago(72), relayOk: ago(72), relayFail: ago(1), listAt: ago(5), listOkAt: ago(5), listFailAt: ago(0.2),
  } });
  await page.goto('/');
  const notice = page.locator('#profileNotice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('La lista del proveedor no se actualiza desde hace 5 h');
  await expect(notice).toContainText('El servicio que habla con tu proveedor no responde');
  await page.screenshot({ path: `test-results/relay-${info.project.name}-aviso.png` });
  await notice.click();
  await expect(page.locator('#downSub')).toContainText('sin probar desde hace 3 días: el servicio que prueba no responde');
});

test('relay andando: sin aviso y la fila dice cuándo es la próxima prueba', async ({ page }) => {
  await fakeWorker(page, { health: { channels: {}, total: 7, checked: ago(2), relayOk: ago(2), relayFail: ago(50), listAt: ago(0.1), listOkAt: ago(0.1), listFailAt: ago(30) } });
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
  await expect(page.locator('#profileNotice')).toBeHidden();
  await page.locator('#tabLinks').click();
  await page.locator('#linksBody .account-row').first().click();
  await expect(page.locator('#downSub')).toContainText('próxima prueba en 18 h');
});
