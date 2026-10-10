// Humo de Perfil (cuentas, perfiles y links): navegar la hoja, crear un perfil y cambiar qué ve.
import { expect, test } from '@playwright/test';
import { fakeWorker, type Fake } from './fake-worker.ts';

let errors: string[] = [];
let fake: Fake;

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Los 404 del Worker de prueba también salen en la consola: esos no cuentan.
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  fake = await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#cards .card').first()).toBeVisible();
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const sheet = (page: import('@playwright/test').Page) => page.locator('#linksDialog');

async function openPerfiles(page: import('@playwright/test').Page) {
  await page.locator('#tabLinks').click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.locator('#linksTitle')).toHaveText('Perfiles');
}

test('la lista muestra la cuenta en uso y sus perfiles', async ({ page }) => {
  await openPerfiles(page);
  const body = page.locator('#linksBody');
  await expect(body.locator('.provider-tag')).toHaveText('Mi proveedor');
  await expect(body.locator('.account-row')).toContainText('Luis');
  await expect(body.locator('.account-row .pc-badge')).toHaveText('En uso');
  await expect(body.locator('.account-row small')).toContainText('1 de 2 en uso');
  await expect(body.locator('.profile-row.sub-row')).toHaveCount(2);
  await expect(body.locator('.profile-row.sub-row').nth(1)).toContainText('sin 1 categoría · sin links');
  await expect(page.locator('#linksBack')).toBeHidden();
});

test('cuenta: datos, perfiles y volver', async ({ page }) => {
  await openPerfiles(page);
  await page.locator('#linksBody .account-row').click();
  await expect(page.locator('#linksTitle')).toHaveText('Luis');
  const stats = page.locator('#linksBody .pc-stats');
  await expect(stats).toContainText('Suscripción');
  await expect(stats).toContainText('1 de 2');
  await expect(page.locator('#downRow')).toBeVisible();
  await expect(page.locator('#linksBody .sub-title')).toHaveText(['Perfiles', 'Cuenta']);
  // Conexiones: qué link está mirando; «‹» vuelve a la cuenta y otra vez, a la lista.
  await page.getByRole('button', { name: 'Conexiones en uso: ver qué links están conectados' }).click();
  await expect(page.locator('#linksTitle')).toHaveText('Conexiones');
  await expect(page.locator('#linksBody .conn-row')).toContainText('TV del living');
  await expect(page.locator('#linksBody .conn-row small')).toHaveText('CNN · hace 20 min');
  await page.locator('#linksBack').click();
  await expect(page.locator('#linksTitle')).toHaveText('Luis');
  await page.locator('#linksBack').click();
  await expect(page.locator('#linksTitle')).toHaveText('Perfiles');
});

test('perfil: el link se copia o se comparte', async ({ page }) => {
  await openPerfiles(page);
  await page.locator('#linksBody .profile-row.sub-row', { hasText: 'Luis' }).click();
  await expect(page.locator('#linksTitle')).toHaveText('Luis');
  const device = page.locator('#linksBody .device');
  await expect(device).toContainText('TV del living');
  await expect(device.getByRole('switch')).toBeChecked();
  await device.getByRole('button', { name: 'Copiar o compartir' }).click();
  await expect(page.getByRole('button', { name: 'Copiar playlist' })).toBeVisible();
  await expect(page.locator('#linksBody .sub-title')).toHaveText('TV del living');
  // «‹» vuelve al perfil.
  await page.locator('#linksBack').click();
  await expect(page.locator('#linksBody .device')).toContainText('TV del living');
});

test('agregar un perfil', async ({ page }) => {
  await openPerfiles(page);
  await page.locator('#linksBody').getByRole('button', { name: 'Agregar perfil' }).click();
  await page.locator('#npName').fill('Abuela');
  await page.getByRole('button', { name: 'Crear perfil' }).click();
  await expect(page.locator('#linksTitle')).toHaveText('Abuela');
  await expect(page.locator('.toast .msg')).toContainText('Perfil «Abuela» creado');
  expect(fake.writes.filter((w) => w.path === '/api/cfg/c1/profiles')).toEqual([{ method: 'POST', path: '/api/cfg/c1/profiles', body: { name: 'Abuela' } }]);
});

test('qué ve un perfil: apagar una categoría y guardar', async ({ page }) => {
  await openPerfiles(page);
  await page.locator('#linksBody .profile-row.sub-row', { hasText: 'Chicos' }).click();
  await page.locator('#linksBody').getByRole('button', { name: /Qué ve/ }).click();
  await expect(page.locator('#pfSum')).toHaveText('Este perfil: sin 1 categoría');
  await page.getByRole('checkbox', { name: 'Noticias: se ve en este perfil' }).uncheck();
  await expect(page.locator('#pfSum')).toHaveText('Este perfil: sin 2 categorías');
  // La búsqueda deja solo lo que coincide.
  await page.locator('#pfQ').fill('infan');
  await expect(page.locator('#pfList .pf-row')).toHaveCount(1);
  await page.locator('#pfQ').fill('');
  await page.locator('#pfSave').click();
  await expect(page.locator('.toast .msg')).toHaveText('Filtro guardado: sin 2 categorías');
  expect(fake.profiles.find((p) => p.id === 'p2')?.filter).toEqual({ groups: ['Deportes', 'Noticias'], channels: [] });
  await expect(page.locator('#linksTitle')).toHaveText('Chicos');
});
