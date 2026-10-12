// Perfil infantil, en la edición (ui/perfiles.tsx): el interruptor de la página del perfil, la hoja con los géneros, las filas
// que aparecen ya activo, «Qué se está ocultando» y quitarlo. La regla la aplica el Worker (test/worker.test.ts).
import { expect, test, type Page } from '@playwright/test';
import { fakeWorker, type Fake } from './fake-worker.ts';

let errors: string[] = [];
let fake: Fake;

for (const theme of ['light', 'dark'] as const) {
  test.describe(`tema ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
      await page.addInitScript((t) => localStorage.setItem('grilla_theme', t), theme);
      fake = await fakeWorker(page);
      await page.goto('/');
      await expect(page.locator('#cards .card').first()).toBeVisible();
    });

    test.afterEach(() => {
      expect(errors).toEqual([]);
    });

    const body = (page: Page) => page.locator('#linksBody');

    async function openChicos(page: Page) {
      await page.locator('#tabLinks').click();
      await expect(page.locator('#linksTitle')).toHaveText('Perfiles');
      await body(page).locator('.profile-row.sub-row', { hasText: 'Chicos' }).click();
      await expect(page.locator('#linksTitle')).toHaveText('Chicos');
    }

    test('activar con la hoja de géneros, ver qué se oculta, cambiar los géneros y quitarlo', async ({ page }, info) => {
      const shot = (name: string) => page.screenshot({ path: `test-results/kids-${info.project.name}-${theme}-${name}.png` });
      await openChicos(page);
      // Apagado: una fila con interruptor, entre «Cuenta» y «Links».
      await expect(body(page).locator('.sub-title')).toContainText(['Para chicos', 'Links']);
      const sw = body(page).getByRole('switch', { name: 'Perfil infantil: Chicos' });
      await expect(sw).not.toBeChecked();
      await expect(body(page)).toContainText('Solo programas aptos, nunca publicidad');
      await expect(body(page).getByRole('button', { name: /Géneros que entran/ })).toHaveCount(0);
      await shot('1-apagado');

      // Prenderlo abre la hoja; el interruptor no cambia hasta guardar.
      await sw.click();
      const dlg = page.locator('#kidsDialog');
      await expect(dlg).toBeVisible();
      await expect(dlg.locator('h2')).toHaveText('Perfil infantil');
      await expect(sw).not.toBeChecked();
      // Infantil y Educativo entran siempre; los demás, apagados.
      for (const g of ['Infantil', 'Educativo']) {
        await expect(dlg.getByRole('button', { name: g, exact: true })).toBeDisabled();
        await expect(dlg.getByRole('button', { name: g, exact: true })).toHaveAttribute('aria-pressed', 'true');
      }
      for (const g of ['Documental', 'Cocina', 'Música', 'Deportes', 'Estilo de vida']) {
        await expect(dlg.getByRole('button', { name: g, exact: true })).toHaveAttribute('aria-pressed', 'false');
      }
      // Ni Películas ni Publicidad se ofrecen.
      for (const g of ['Película', 'Serie', 'Noticias', 'Publicidad']) await expect(dlg.getByRole('button', { name: g, exact: true })).toHaveCount(0);
      await expect(dlg).toContainText('Lo que la IA no pudo clasificar no se muestra');
      await expect(dlg).toContainText('va clasificando de a poco');
      await expect(dlg).toContainText('la playlist y la guía del reproductor no se filtran');
      await dlg.getByRole('button', { name: 'Documental', exact: true }).click();
      await expect(dlg.getByRole('button', { name: 'Documental', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await shot('2-hoja');
      // Cancelar no cambia nada.
      await dlg.getByRole('button', { name: 'Cancelar' }).click();
      await expect(dlg).toBeHidden();
      expect(fake.writes.filter((w) => w.path.includes('/profiles/'))).toEqual([]);

      await sw.click();
      await dlg.getByRole('button', { name: 'Documental', exact: true }).click();
      await dlg.getByRole('button', { name: 'Activar' }).click();
      await expect(dlg).toBeHidden();
      expect(fake.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/api/cfg/c1/profiles/p2', body: { kids: { genres: ['Documental'] } } });
      expect(fake.profiles.find((p) => p.id === 'p2')?.kids).toEqual({ genres: ['Infantil', 'Educativo', 'Documental'] });

      // Activo: el interruptor prendido y dos filas más.
      await expect(sw).toBeChecked();
      await expect(body(page)).toContainText('Activo');
      await expect(body(page).getByRole('button', { name: /Géneros que entran/ })).toContainText('Infantil, Educativo y Documental');
      await expect(body(page)).toContainText('Para sacarlo hace falta la clave de edición');
      await shot('3-activo');

      // Qué se está ocultando: por género, con ejemplos, y lo sin clasificar.
      await body(page).getByRole('button', { name: /Qué se está ocultando/ }).click();
      await expect(body(page)).toContainText('5 programas se ven y 7 se ocultan');
      await expect(body(page).locator('.menu-row')).toHaveCount(3);
      await expect(body(page).locator('.menu-row').first()).toContainText('Sin clasificar · 4 programas');
      await expect(body(page).locator('.menu-row').first()).toContainText('Misterio en la casa');
      await expect(body(page)).toContainText('este perfil se va completando');
      await shot('4-oculto');
      await page.locator('#linksBack').click();
      await expect(page.locator('#linksTitle')).toHaveText('Chicos');

      // Cambiar los géneros: la misma hoja, con «Guardar».
      await body(page).getByRole('button', { name: /Géneros que entran/ }).click();
      await expect(dlg.locator('h2')).toHaveText('Géneros que entran');
      await expect(dlg.getByRole('button', { name: 'Documental', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await dlg.getByRole('button', { name: 'Documental', exact: true }).click();
      await dlg.getByRole('button', { name: 'Deportes', exact: true }).click();
      await dlg.getByRole('button', { name: 'Guardar' }).click();
      await expect(body(page).getByRole('button', { name: /Géneros que entran/ })).toContainText('Infantil, Educativo y Deportes');

      // Quitarlo: confirma qué cambia.
      await sw.click();
      const ask = page.locator('#askDialog');
      await expect(ask).toContainText('va a volver a ver todo');
      await shot('5-quitar');
      await ask.getByRole('button', { name: 'Quitar' }).click();
      await expect(sw).not.toBeChecked();
      expect(fake.writes.at(-1)).toMatchObject({ method: 'PUT', path: '/api/cfg/c1/profiles/p2', body: { kids: null } });
      expect(fake.profiles.find((p) => p.id === 'p2')?.kids).toBeUndefined();
      await expect(body(page).getByRole('button', { name: /Géneros que entran/ })).toHaveCount(0);
    });

    test('quitarlo y cancelar deja el perfil infantil como estaba', async ({ page }) => {
      fake.profiles.find((p) => p.id === 'p2')!.kids = { genres: ['Infantil', 'Educativo'] };
      await page.reload();
      await expect(page.locator('#cards .card').first()).toBeVisible();
      await openChicos(page);
      const sw = body(page).getByRole('switch', { name: 'Perfil infantil: Chicos' });
      await expect(sw).toBeChecked();
      await sw.click();
      await page.locator('#askDialog').getByRole('button', { name: 'Cancelar' }).click();
      await expect(sw).toBeChecked();
      expect(fake.writes.filter((w) => w.path.includes('/profiles/'))).toEqual([]);
    });
  });
}
