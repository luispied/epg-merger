// Humo de «La guía no coincide» en el editor (ui/reports.tsx): lo que se marcó desde el modo ver aparece arriba de
// Canales; la hoja abre el canal para cambiarle la guía o lo da por resuelto.
import { expect, test } from '@playwright/test';
import { fakeWorker } from './fake-worker.ts';

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('lo marcado desde el modo ver se ve, abre el canal y se da por resuelto', async ({ page }, info) => {
  const fake = await fakeWorker(page);
  fake.reports = [
    { id: '4', name: 'CNN', epg: 'g00000000000002.ar', title: 'Noticiero', by: 'Abuela', at: new Date(Date.now() - 600_000).toISOString() },
    { id: '1', name: 'ESPN', epg: null, by: 'Abuela', at: new Date(Date.now() - 7_200_000).toISOString() },
  ];
  await page.goto('/');
  const notice = page.locator('#reportNotice');
  await expect(notice).toContainText('2 canales con la guía que no coincide');
  await expect(notice).toContainText('Lo marcó Abuela');
  await page.screenshot({ path: `test-results/ver-${info.project.name}-aviso.png` });
  await notice.click();
  const sheet = page.locator('dialog.rp-sheet');
  await expect(sheet.locator('.rp-row')).toHaveCount(2);
  await expect(sheet.locator('.rp-row').first()).toContainText('La guía decía «Noticiero» · Abuela');
  await page.screenshot({ path: `test-results/ver-${info.project.name}-marcados.png` });
  await sheet.locator('.rp-row', { hasText: 'ESPN' }).getByRole('button', { name: 'Resuelto' }).click();
  await expect(sheet.locator('.rp-row')).toHaveCount(1);
  await expect(notice).toContainText('La guía de «CNN» no coincide');
  expect(fake.reports.map((r) => r.id)).toEqual(['4']);
  // «Cambiar guía» abre la hoja del canal.
  await sheet.getByRole('button', { name: 'Cambiar guía' }).click();
  await expect(page.locator('#channelDialog')).toBeVisible();
  await expect(page.locator('#channelDialog')).toContainText('CNN');
});
