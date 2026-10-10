// Arma worker/public/ (lo que Cloudflare sirve como archivos estáticos junto al Worker):
// la web de web/ compilada con esbuild (incluye @grilla/core de ../core) y los estilos e
// íconos de web/. Lo corre wrangler antes de publicar ([build] en wrangler.toml).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

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
// Un solo CSS: los estilos base (web/base.css) y los de la web (web/web.css, que van después y mandan).
writeFileSync(here('./public/app.css'), `${readFileSync(here('./web/base.css'), 'utf-8')}\n${readFileSync(here('./web/web.css'), 'utf-8')}`);
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
console.log(`public/ listo (app ${appVersion}, v=${version})`);
