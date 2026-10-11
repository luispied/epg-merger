// Arma worker/public/ (lo que Cloudflare sirve como archivos estáticos junto al Worker):
// la web de web/ compilada con esbuild (incluye @grilla/core de ../core) y los estilos e
// íconos de web/. Lo corre wrangler antes de publicar ([build] en wrangler.toml).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { expandTokens } from './tokens.mjs';

const here = (p) => new URL(p, import.meta.url);
mkdirSync(here('./public'), { recursive: true });

// Versión de la app (worker/package.json) y, si hay git, el commit: se ven al pie de Configuración.
const appVersion = JSON.parse(readFileSync(here('./package.json'), 'utf-8')).version;
let appCommit = '';
try { appCommit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* sin git */ }

// El editor (app.ts) y el modo «solo ver» (ver.tsx, ver.html): dos páginas que no comparten estado.
const common = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  // Componentes en TSX con Preact (web/ui/).
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  sourcemap: false,
  define: { __APP_VERSION__: JSON.stringify(appVersion), __APP_COMMIT__: JSON.stringify(appCommit) },
  logLevel: 'warning',
};
await build({ ...common, entryPoints: [here('./web/app.ts').pathname], outfile: here('./public/app.js').pathname });
await build({ ...common, entryPoints: [here('./web/ver.tsx').pathname], outfile: here('./public/ver.js').pathname });
// Un solo CSS: los tokens (web/tokens.css, con el claro y el oscuro expandidos), los estilos base (web/base.css) y los de
// la web (web/web.css, que van después y mandan).
const css = (f) => readFileSync(here(`./web/${f}`), 'utf-8');
writeFileSync(here('./public/app.css'), [expandTokens(css('tokens.css')), css('base.css'), css('web.css')].join('\n'));
mkdirSync(here('./public/fonts'), { recursive: true });
cpSync(here('./web/fonts'), here('./public/fonts'), { recursive: true });
cpSync(here('./web/icons.js'), here('./public/icons.js'));
// Íconos de la app (para "Agregar a inicio" en el iPhone y Android).
cpSync(here('./web/img'), here('./public/img'), { recursive: true });
const manifest = JSON.parse(readFileSync(here('./web/manifest.webmanifest'), 'utf-8'));
manifest.description = 'Tu lista de canales ordenada, con guía de programación, en tu reproductor.';
writeFileSync(here('./public/manifest.webmanifest'), JSON.stringify(manifest, null, 2));

// ?v= con el hash del contenido: el HTML nuevo nunca carga JS o CSS viejos de la caché.
const hash = createHash('sha256');
for (const f of ['app.js', 'ver.js', 'app.css', 'icons.js', 'fonts/inter-latin.woff2']) hash.update(readFileSync(here(`./public/${f}`)));
const version = hash.digest('hex').slice(0, 10);
writeFileSync(here('./public/index.html'), readFileSync(here('./web/index.html'), 'utf-8').replaceAll('__VERSION__', version));
writeFileSync(here('./public/ver.html'), readFileSync(here('./web/ver.html'), 'utf-8').replaceAll('__VERSION__', version));
// El service worker (sin conexión) guarda la app de esta versión.
writeFileSync(here('./public/sw.js'), readFileSync(here('./web/sw.js'), 'utf-8').replaceAll('__VERSION__', version));
// Novedades: las últimas versiones del CHANGELOG, solo lo que le sirve a quien usa la app (sin las líneas del Worker,
// de tests ni rutas de archivos). Las muestra la hoja «Novedades» y el Worker las usa para el aviso de versión nueva.
writeFileSync(here('./public/novedades.json'), JSON.stringify(novedades(readFileSync(here('../CHANGELOG.md'), 'utf-8'))));
console.log(`public/ listo (app ${appVersion}, v=${version})`);

/** [{ version, items }] de las últimas `max` versiones del CHANGELOG, en texto para la gente: sin las líneas técnicas,
 *  sin los paréntesis con rutas o nombres de código y sin las comillas invertidas. Deja el **negrita**. */
export function novedades(md, max = 12) {
  const out = [];
  for (const sec of md.split(/^## /m).slice(1)) {
    const [head, ...rest] = sec.split('\n');
    const version = head.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const items = rest.join('\n').split(/\n(?=- )/).map((b) => b.trim()).filter((b) => b.startsWith('- '))
      .map((b) => b.slice(2).replace(/\s*\n\s*/g, ' ').trim())
      .filter((b) => !/^(Worker|Interno|Tests?|Tests de humo|Test de humo|Regla nueva del proyecto)\b/i.test(b) && !/\bTests?\b|\be2e\b/.test(b))
      .map((b) => b.replace(/\s*\([^()]*`[^()]*\)/g, '').replace(/`/g, '').replace(/\s*Ver planes\/\S+/g, '').replace(/\s+([.,;:])/g, '$1'))
      .filter(Boolean);
    if (items.length) out.push({ version, items });
    if (out.length >= max) break;
  }
  return out;
}
