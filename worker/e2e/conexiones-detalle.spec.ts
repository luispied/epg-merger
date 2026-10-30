// El detalle de una hora de la barra de 24 horas (perfiles.tsx, HourDetail): aparece al tocar una barra, tocar otra la
// cambia, y la misma o «Cerrar» lo ocultan. Muestra el pico de esa hora y los links que abrieron un canal en ella.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

const HOUR_MS = 3600 * 1000;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const hourStart = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS).toISOString();
const dev = (code: string, name: string, extra: Record<string, unknown> = {}) => ({
  code, name, active: true, lastUsed: ago(60), accountKey: 'ak1', profile: 'p1', playlistUrl: `https://grilla.test/p/${code}`, epgUrl: `https://grilla.test/e/${code}`, ...extra,
});
let errors: string[] = [];

test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

const hours = Array.from({ length: 24 }, (_, i) => (i >= 20 ? 2 : null));
hours[23] = 3;

for (const scheme of ['light', 'dark'] as const) {
  test(`conexiones: el detalle de una hora se abre, cambia y se cierra (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await fakeWorker(page, {
      accounts: { ak1: { expires: new Date(Date.now() + 20 * 86_400_000).toISOString(), maxConnections: 5, activeConnections: 3 } },
      history: { ak1: { hours, rises: [] } },
      devices: [dev('d1', 'TV del living', { lastPlay: { t: ago(5), ch: '4' } }), dev('d2', 'Tablet')],
      hist: { d1: [{ t: hourStart, ch: '4' }], d2: [] },
    });
    await page.goto('/');
    await expect(page.locator('#editor')).toBeVisible();
    await page.locator('#tabLinks').click();
    await page.locator('#linksBody .account-row').click();
    await page.getByRole('button', { name: 'Conexiones en uso: ver qué links están conectados' }).click();
    await expect(page.locator('#linksTitle')).toHaveText('Conexiones');

    const bars = page.locator('#linksBody .hour-bars i[role="button"]');
    await expect(bars).toHaveCount(24);
    // Sin tocar, no hay detalle.
    await expect(page.locator('#linksBody .hour-detail')).toHaveCount(0);

    // Tocar la hora actual: pico de 3 y el link que abrió un canal en esa hora.
    await bars.nth(23).click();
    const detail = page.locator('#linksBody .hour-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Pico: 3 conexiones en uso');
    await expect(detail.locator('.device-info strong')).toHaveText(['CNN']);
    await expect(detail.locator('.device-info small')).toHaveText(['TV del living']);
    await expect(bars.nth(23)).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: `test-results/conexiones-detalle-${scheme}.png`, fullPage: true });

    // Tocar otra barra la cambia: la hora nueva no tiene links.
    await bars.nth(22).click();
    await expect(bars.nth(22)).toHaveAttribute('aria-pressed', 'true');
    await expect(bars.nth(23)).toHaveAttribute('aria-pressed', 'false');
    await expect(detail).toContainText('Ningún link abrió un canal en esta hora.');

    // La misma barra cierra el detalle, y «Cerrar» también.
    await bars.nth(22).click();
    await expect(detail).toHaveCount(0);
    await bars.nth(23).click();
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: 'Cerrar' }).click();
    await expect(detail).toHaveCount(0);
  });
}
