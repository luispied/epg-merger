// Humo de la hoja de un canal (ui/canal.tsx): la guía que encontró sola, ir al siguiente, renombrar, dejar sin guía y
// volver a la automática, buscar y elegir otra guía, mover de categoría y ocultar. Lo que se cambia se guarda en el Worker.
import { expect, test, type Page } from '@playwright/test';
import { fakeWorker, type Fake } from './fake-worker.ts';

let errors: string[] = [];
let fake: Fake;

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  fake = await fakeWorker(page);
  await page.goto('/');
  await expect(page.locator('#cards .card').first()).toBeVisible();
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const sheet = (page: Page) => page.locator('#channelDialog');
const name = (page: Page) => page.locator('#channelName');
const current = (page: Page) => sheet(page).locator('.ch-current');
async function openChannel(page: Page, ch: string) {
  await page.locator('#cards .card', { hasText: ch }).first().click();
  await expect(sheet(page)).toBeVisible();
  await expect(name(page)).toHaveValue(ch);
}
/** Lo último que la app mandó al Worker para un canal. */
const savedEdit = (f: Fake, ch: string) => f.writes.filter((w) => w.path === '/api/cfg/c1' && w.method === 'PUT')
  .map((w) => (w.body as { channels: Record<string, unknown> }).channels[ch]).at(-1);

test('la guía que encontró sola, ‹ › y renombrar', async ({ page }) => {
  await openChannel(page, 'ESPN');
  await expect(sheet(page).locator('.ch-meta .prov')).toHaveText('ESPN');
  await expect(sheet(page).locator('select.move')).toHaveValue('Deportes');
  await expect(current(page).locator('.gc-name')).toContainText('ESPN');
  await expect(current(page).locator('.gc-chip')).toHaveClass(/ok/);
  await expect(sheet(page).getByRole('button', { name: 'Canal anterior' })).toBeDisabled();

  await sheet(page).getByRole('button', { name: 'Canal siguiente' }).click();
  await expect(name(page)).toHaveValue('Fox Sports');
  await expect(current(page)).toContainText('Sin guía asignada.');
  await sheet(page).getByRole('button', { name: 'Canal anterior' }).click();
  await expect(name(page)).toHaveValue('ESPN');

  await name(page).fill('ESPN HD');
  await name(page).press('Enter');
  await expect(page.locator('.toast .msg').last()).toContainText('Nombre guardado');
  await expect(name(page)).toHaveValue('ESPN HD');
  await expect.poll(() => savedEdit(fake, 'ESPN')).toMatchObject({ name: 'ESPN HD' });
});

test('sin guía, automática y elegir otra guía', async ({ page }) => {
  await openChannel(page, 'ESPN');
  const auto = sheet(page).getByRole('button', { name: 'Automática' });
  await expect(auto).toBeDisabled();
  await sheet(page).locator('.ch-chips').getByRole('button', { name: 'Sin guía' }).click();
  await expect(current(page)).toContainText('Sin guía, a propósito.');
  await expect(auto).toBeEnabled();
  await auto.click();
  await expect(current(page).locator('.gc-name')).toContainText('ESPN');

  // Buscar otra guía y elegirla: queda «Elegida por vos».
  await sheet(page).getByRole('searchbox', { name: 'Buscar otra guía' }).fill('rural');
  const result = sheet(page).locator('.search-results [data-pick]', { hasText: 'Canal Rural' });
  await expect(result).toBeVisible();
  await result.click();
  await expect(current(page).locator('.gc-name')).toContainText('Canal Rural');
  await expect(current(page).locator('.gc-chip')).toHaveText('Elegida por vos');
  await expect(sheet(page).getByRole('searchbox', { name: 'Buscar otra guía' })).toHaveValue('');
  await expect.poll(() => savedEdit(fake, 'ESPN')).toMatchObject({ epg: 'g00000000000003.ar', manual: true });
});

test('mover de categoría y ocultar', async ({ page }) => {
  await openChannel(page, 'TN');
  await sheet(page).locator('select.move').selectOption('Deportes');
  await expect(page.locator('.toast .msg').last()).toContainText('Movido a Deportes');
  await expect(sheet(page).locator('.cat-chip-text')).toHaveText('Deportes');

  await sheet(page).locator('summary', { hasText: 'Más opciones' }).click();
  await sheet(page).locator('.opt-row', { hasText: 'Visible en la playlist' }).getByRole('switch').uncheck();
  await expect(page.locator('.toast .msg').last()).toContainText('Oculto');
  await expect.poll(() => savedEdit(fake, 'TN')).toMatchObject({ group: 'Deportes', hidden: true });
});
