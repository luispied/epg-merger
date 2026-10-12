// Humo del modo «solo ver» (ver.tsx): con el código en la dirección, muestra los canales del perfil con lo que dan
// ahora, la hoja de un canal y la Guía sin nada para editar; un link quitado dice que ya no funciona.
import { expect, test } from '@playwright/test';

const H = Math.floor(Date.now() / 3_600_000) * 3600; // hora UTC en curso
const hourKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 13).replace(/\D/g, '');
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
// Código de la casa de prueba: el Worker lo acepta solo con su clave (ver isHomeCode en ver.tsx).
const HOME = 'hogarPrueba0123456789.ClaveCasa0123456789abcdef';

const view = {
  name: 'Abuela',
  channels: [
    { id: '1', name: 'Canal Uno', cat: 'Noticias', epg: 'g0000000000001.uy', logo: '' },
    { id: '2', name: 'Canal Dos', cat: 'Noticias', epg: 'g0000000000002.uy', logo: '' },
    { id: '3', name: 'Cine Clásico', cat: 'Películas', epg: 'g0000000000003.uy', logo: '' },
    { id: '4', name: 'Canal Local', cat: 'Películas', epg: null, logo: '', quiet: true },
  ],
};
// Cada canal: un programa en el aire y otro la hora siguiente.
const titles: Record<string, [string, string]> = {
  'g0000000000001.uy': ['Noticiero central', 'Pronóstico del tiempo'],
  'g0000000000002.uy': ['Almorzando con amigos', 'La tarde es nuestra'],
  'g0000000000003.uy': ['Casablanca', 'Lo que el viento se llevó'],
};
const hour = (h: number) => ({
  h, t: Object.values(titles).map((t) => t[h === H ? 0 : 1]),
  c: Object.fromEntries(Object.keys(titles).map((id, k) => [id, [h === H ? [-40, 60, k] : [0, 60, k]]])),
});

let errors: string[] = [];
let gone = false;
let reported: unknown[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  gone = false;
  reported = [];
  // Reloj fijo a las y 20 de la hora de H: si la prueba cruza una hora, la app no ve los datos de la hora anterior.
  await page.clock.setFixedTime(new Date(H * 1000 + 20 * 60_000));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (r) => {
    const path = new URL(r.request().url()).pathname;
    // El modo ver no escribe nada.
    if (r.request().method() !== 'GET' && path !== '/api/ui/again' && path !== `/api/view/${CODE}/report`) errors.push(`escribió ${path}`);
    if (path === `/api/view/${CODE}/connections`) {
      return r.fulfill({ json: { inUse: 2, max: 2, watching: [
        { name: 'TV del living', channel: 'Canal Uno', t: new Date(H * 1000).toISOString() },
        { name: 'Tablet', channel: 'Cine Clásico', t: new Date(H * 1000 + 17 * 60_000).toISOString() },
      ] } });
    }
    if (path === `/api/view/${CODE}/report`) {
      reported.push(r.request().postDataJSON());
      return r.fulfill({ json: { ok: true } });
    }
    if (path.startsWith('/api/home/')) {
      const ok = r.request().headers().authorization === `Bearer ${HOME.split('.')[1]}`;
      return ok ? r.fulfill({ json: { data: '' } }) : r.fulfill({ status: 403, json: { error: 'no' } });
    }
    if (path === `/api/view/${CODE}`) return gone ? r.fulfill({ status: 404, json: { error: 'no' } }) : r.fulfill({ json: view });
    const m = path.match(/^\/api\/(?:ui\/schedule|(?:cfg|view)\/[^/]+)\/hour\/(\d{10})\.json$/);
    if (m) {
      for (const h of [H, H + 3600]) if (hourKey(h) === m[1]) return r.fulfill({ json: hour(h) });
      return r.fulfill({ status: 404, json: {} });
    }
    if (path.startsWith('/api/ui/schedule/')) {
      return r.fulfill({ json: [[H - 2400, H + 3600, 'Noticiero central', 'Las noticias del día, con todo lo que pasó.'], [H + 3600, H + 7200, 'Pronóstico del tiempo'], [H + 7200, H + 9000, 'Deportes al cierre']] });
    }
    if (path === '/api/ui/again') return r.fulfill({ json: { ids: [], r: [] } });
    return r.fulfill({ status: 404, json: { error: 'sin red en el test' } });
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('los canales del perfil con lo que dan ahora, la hoja del canal y la Guía sin editar', async ({ page }, info) => {
  await page.goto(`/ver#${CODE}`);
  await expect(page.locator('.vw-who')).toContainText('Abuela');
  await expect(page.locator('.vw-row')).toHaveCount(4);
  await expect(page.locator('.vw-cat')).toHaveText(['Noticias', 'Películas']);
  const first = page.locator('.vw-row').first();
  await expect(first).toContainText('Noticiero central');
  await expect(first).toContainText('Después: Pronóstico del tiempo');
  // Lo que queda va primero y entero (con letra grande no se corta). Justo al empezar la hora quedan 60 minutos: «1 h».
  await expect(first.locator('.vw-left')).toHaveText(/^Quedan (\d+ min|\d+ h( \d+ min)?) · hasta las \d\d:\d\d$/);
  await expect(page.locator('.vw-row').nth(3)).toContainText('Sin guía');
  // Las conexiones de la cuenta y qué mira cada link.
  const conn = page.locator('.vw-conn');
  await expect(conn.locator('.vw-conn-n')).toHaveText('2 de 2');
  await expect(conn).toContainText('Conexiones en uso');
  // Cerrado muestra solo «N de M»; tocarlo despliega qué mira cada link.
  await expect(conn.locator('.vw-conn-row')).toHaveCount(0);
  await page.screenshot({ path: `test-results/ver-${info.project.name}-conexiones.png` });
  await conn.getByRole('button', { name: /Conexiones en uso/ }).click();
  await expect(conn).toContainText('Están todas ocupadas');
  await expect(conn.locator('.vw-conn-row')).toHaveCount(2);
  await expect(conn.locator('.vw-conn-row').first()).toContainText('Canal Uno · hace 20 min');
  await page.screenshot({ path: `test-results/ver-${info.project.name}-canales.png` });
  // Buscar por programa.
  await page.getByRole('searchbox').fill('casablanca');
  await expect(page.locator('.vw-row')).toHaveCount(1);
  await expect(page.locator('.vw-row')).toContainText('Cine Clásico');
  await page.getByRole('searchbox').fill('');
  // La hoja del canal: lo de ahora con su descripción y lo que viene, sin avisos.
  await first.click();
  const sheet = page.locator('dialog.vw-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Las noticias del día');
  await expect(sheet).toContainText('Deportes al cierre');
  await expect(sheet.locator('.remind-btn, .gd-remind')).toHaveCount(0);
  await page.screenshot({ path: `test-results/ver-${info.project.name}-canal.png` });
  // Avisar que la guía no coincide.
  await sheet.getByRole('button', { name: 'Lo que dan en la tele no es esto' }).click();
  await expect(sheet).toContainText('le avisamos a quien arma la grilla');
  expect(reported).toEqual([{ id: '1', title: 'Noticiero central' }]);
  await page.screenshot({ path: `test-results/ver-${info.project.name}-avisado.png` });
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // La Guía: los programas, sin «Cambiar la guía» ni avisos.
  await page.getByRole('button', { name: 'Guía' }).click();
  await expect(page.locator('#guide')).toBeVisible();
  await expect(page.locator('.gd-cell.live')).toHaveCount(3);
  await expect(page.locator('.gd-cell.gap.quiet')).toContainText('Este canal no tiene programación');
  await page.screenshot({ path: `test-results/ver-${info.project.name}-guia.png` });
  await page.locator('.gd-cell.live').first().click();
  const prog = page.locator('dialog.gd-sheet');
  await expect(prog).toContainText('En el aire');
  await expect(prog.locator('.gd-sh-fix')).toHaveCount(0);
  await expect(prog.locator('.remind-btn, .gd-remind')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Próximos y «Tu noche» también, sin avisos.
  await page.getByRole('radio', { name: 'Próximos' }).click();
  await expect(page.locator('#guide')).toContainText('Pronóstico del tiempo');
  await page.locator('#guide .gd-teaser').click();
  await expect(page.locator('#guide .remind-btn, #guide .gd-remind')).toHaveCount(0);
  await expect(page.locator('.gd-plan-lead')).not.toContainText('campana');
});

test('un link quitado o sin código dice qué hacer', async ({ page }, info) => {
  gone = true;
  await page.goto(`/ver#${CODE}`);
  await expect(page.locator('.vw-problem')).toContainText('Este código ya no funciona');
  await page.screenshot({ path: `test-results/ver-${info.project.name}-quitado.png` });
  await page.evaluate(() => localStorage.clear());
  await page.goto('/ver');
  await expect(page.locator('.vw-problem')).toContainText('Falta el código');
});

test('pegar el código para ver al abrir nowline deja el dispositivo en modo ver, hasta salir', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#onboarding')).toBeVisible();
  await page.locator('#homeLink').click();
  await page.locator('#askDialog input').fill(`ver.${CODE}`);
  await page.locator('#askCheck').click();
  await expect(page).toHaveURL(/\/ver#/);
  await expect(page.locator('.vw-row')).toHaveCount(4);
  // Abrir nowline otra vez (el ícono de inicio) vuelve al modo ver.
  await page.goto('/');
  await expect(page).toHaveURL(/\/ver#/);
  await expect(page.locator('.vw-who')).toContainText('Abuela');
  // Salir pide el código de la casa: otro código no sirve y el dispositivo sigue en modo ver.
  await page.getByRole('button', { name: 'Salir del modo ver' }).click();
  await page.getByLabel('Código de la casa').fill('otro0123456789abcdef.otraclave0123456789abcdef');
  await page.locator('dialog.ask-sheet button[type=submit]').click();
  await expect(page.locator('dialog.ask-sheet [role=alert]')).toBeVisible();
  await expect(page).toHaveURL(/\/ver#/);
  // Con el código de la casa sale y vuelve a la bienvenida.
  await page.getByLabel('Código de la casa').fill(HOME);
  await page.locator('dialog.ask-sheet button[type=submit]').click();
  await expect(page.locator('#onboarding')).toBeVisible();
});

test('el ? del modo ver abre su ayuda, también desde la Guía', async ({ page }, info) => {
  await page.goto(`/ver#${CODE}`);
  await page.getByRole('button', { name: 'Cómo se usa' }).click();
  const help = page.locator('dialog.vw-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('Lo que dan en la tele no es esto');
  await page.screenshot({ path: `test-results/ver-${info.project.name}-ayuda.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await page.getByRole('button', { name: 'Guía' }).click();
  await page.getByRole('button', { name: 'Cómo usar la Guía' }).click();
  await expect(page.locator('dialog.vw-help')).toBeVisible();
});

test('filtrar por categoría como en la edición, sin estados', async ({ page }) => {
  await page.goto(`/ver#${CODE}`);
  await expect(page.locator('.vw-row')).toHaveCount(4);
  await page.locator('.filter-btn').click();
  const sheet = page.locator('.filter-sheet');
  await expect(sheet.getByRole('heading', { name: 'Estado' })).toHaveCount(0);
  await sheet.getByRole('button', { name: /^Películas/ }).click();
  await sheet.getByRole('button', { name: 'Listo' }).click();
  await expect(page.locator('.vw-row')).toHaveCount(2);
  await expect(page.locator('.active-filters .chip-btn', { hasText: 'Películas' })).toBeVisible();
  await expect(page.locator('.filter-btn')).toHaveAttribute('aria-label', 'Filtrar, 1 activo');
  await page.locator('.active-filters .chip-btn', { hasText: 'Películas' }).click();
  await expect(page.locator('.vw-row')).toHaveCount(4);
  await expect(page.locator('.active-filters')).toBeHidden();
});

// Igual que la edición: la lista de Canales queda en la página debajo de la Guía (el documento no se vacía al cambiar de
// pestaña) y la barra de abajo queda a 1rem del borde en las dos. En la app de iPhone, una página vacía sube la barra.
test('la barra de abajo del modo ver queda a 1rem del borde en Canales y en la Guía, como en la edición', async ({ page }) => {
  await page.goto(`/ver#${CODE}`);
  const nav = page.getByRole('navigation', { name: 'Secciones' });
  await expect(page.getByText('Canal Uno').first()).toBeVisible();
  const pos = () => nav.evaluate((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; });
  const alto = () => page.evaluate(() => document.documentElement.scrollHeight);
  const vh = await page.evaluate(() => window.innerHeight);
  const canales = await pos();
  if (await page.evaluate(() => innerWidth < 900)) expect(canales[1]).toBe(vh - 16);
  const h = await alto();
  await page.getByRole('button', { name: 'Guía', exact: true }).click();
  await expect(page.locator('#guide')).toBeVisible();
  expect(await alto()).toBe(h);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');
  expect(await pos()).toEqual(canales);
  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('button', { name: 'Canales' }).click();
  await expect(page.getByText('Canal Uno').first()).toBeVisible();
  expect(await pos()).toEqual(canales);
});

// Sin manifest, «Agregar a inicio» abre la PWA de iPhone en un modo viejo y la barra de abajo queda más arriba que en la
// edición. El modo ver agrega el suyo, con su código (lo arma el Worker en /ver-app/<código>.webmanifest).
test('el modo ver trae su manifest con el código', async ({ page }) => {
  await page.goto(`/ver#${CODE}`);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', `/ver-app/${CODE}.webmanifest`);
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
});
