// La pantalla de inicio (#splash): el logo al abrir, que se va solo y no vuelve al recargar en la misma sesión. En el
// resto de los tests no aparece (navigator.webdriver); acá se hace pasar por un navegador común.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
  await page.route('**/api/**', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: '{}' }));
});

test('el logo se ve al abrir, se va solo y no vuelve al recargar', async ({ page }) => {
  await page.goto('/');
  const splash = page.locator('#splash');
  await expect(splash).toBeVisible();
  await expect(splash.locator('.wordmark')).toHaveText('nowlıne');
  // No tapa los toques: la bienvenida ya se puede usar debajo.
  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(splash).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/no-splash/);
  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(splash).toHaveCount(0);
});

test('en el modo ver se va cuando hay algo para mostrar', async ({ page }) => {
  await page.goto('/ver#codigo-que-no-existe');
  await expect(page.locator('#splash')).toBeVisible();
  await expect(page.getByText('No se pudo cargar')).toBeVisible();
  await expect(page.locator('#splash')).toHaveCount(0);
});
