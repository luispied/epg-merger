// Arma las imágenes de inicio del iPhone (web/img/splash/): lo que muestra iOS al abrir Nowline desde la pantalla de
// inicio, antes de que cargue la página. Son la misma pantalla de inicio de index.html (#splash) en el tema oscuro, en
// el tamaño de cada iPhone, así no hay salto cuando aparece la nuestra. Se corre a mano si cambia el logo o la pantalla:
//   node build.mjs && node splash-images.mjs
// y escribe además los <link rel="apple-touch-startup-image"> para pegar en index.html y ver.html.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const here = (p) => new URL(p, import.meta.url).pathname;
// [ancho, alto, escala]: los puntos de pantalla de cada familia de iPhone, en vertical.
const SIZES = [
  [440, 956, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3],
  [375, 812, 3], [414, 896, 3], [414, 896, 2], [414, 736, 3], [375, 667, 2],
];
const splash = readFileSync(here('./web/index.html'), 'utf-8').match(/<div id="splash"[\s\S]*?<\/div>/)[0];
const page0 = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="app.css"></head><body>${splash}</body></html>`;

// Se abre desde public/ (lo que arma build.mjs) para que tome app.css y la fuente.
writeFileSync(here('./public/_splash.html'), page0);
mkdirSync(here('./web/img/splash'), { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const links = [];
for (const [w, h, s] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: s });
  await page.goto(`file://${here('./public/_splash.html')}`);
  await page.evaluate(() => document.fonts.ready);
  const name = `splash-${w * s}x${h * s}.png`;
  await page.screenshot({ path: here(`./web/img/splash/${name}`) });
  await page.close();
  links.push(`<link rel="apple-touch-startup-image" href="img/splash/${name}" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${s}) and (orientation: portrait)">`);
}
await browser.close();
rmSync(here('./public/_splash.html'));
console.log(links.join('\n'));
