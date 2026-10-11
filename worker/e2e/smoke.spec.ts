// Humo de la web: arranca sin errores, la bienvenida responde y el aviso (Preact) aparece y se cierra.
import { expect, test } from '@playwright/test';

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Los 502 simulados de abajo también salen en la consola: esos no cuentan.
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  // Sin Worker: toda llamada a /api falla como si el proveedor no atendiera.
  await page.route('**/api/**', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"sin red en el test"}' }));
  await page.goto('/');
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('arranca en la bienvenida', async ({ page }) => {
  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(page.locator('#onboarding .wordmark')).toContainText('Nowline');
  await expect(page.locator('#onboarding [data-version]')).toContainText('Nowline 1.');
  // Los íconos se dibujan (hydrateIcons).
  await expect(page.locator('#demoBtn svg.icon')).toHaveCount(1);
});

test('el tipo de proveedor cambia el formulario', async ({ page }) => {
  await expect(page.locator('#xtreamForm')).toBeVisible();
  await page.getByRole('radio', { name: 'Lista M3U' }).click();
  await expect(page.locator('#m3uForm')).toBeVisible();
  await expect(page.locator('#xtreamForm')).toBeHidden();
  await page.getByRole('radio', { name: 'Xtream Codes' }).click();
  await expect(page.locator('#xtreamForm')).toBeVisible();
});

test('el aviso aparece, se reemplaza y se cierra', async ({ page }) => {
  // El proveedor "no deja" bajar la lista: aparece la opción de subirla a mano.
  await page.locator('#servers').fill('http://proveedor.test:8080');
  await page.locator('#username').fill('usuario');
  await page.locator('#password').fill('clave');
  await page.locator('#xtreamForm button[type=submit]').click();
  await expect(page.locator('#uploadBox')).toBeVisible();
  // Sin contraseña el link de descarga no sirve y lo dice con un aviso.
  await page.locator('#password').fill('');
  await page.locator('#m3uDownload').click();
  const toast = page.locator('.toasts .toast');
  await expect(toast).toHaveCount(1);
  await expect(toast).toHaveClass(/\bbad\b/);
  await expect(toast.locator('.msg')).toHaveText('Completá servidores, usuario y contraseña arriba');
  await expect(toast.locator('svg.icon')).toHaveCount(2);
  // Uno a la vez: el segundo reemplaza al primero.
  await page.locator('#m3uDownload').click();
  await expect(toast).toHaveCount(1);
  await page.getByRole('button', { name: 'Cerrar el aviso' }).click();
  await expect(toast).toHaveCount(0);
});
