// Arma worker/public/ (lo que Cloudflare sirve como archivos estáticos junto al Worker):
// la web de web/ compilada con esbuild (incluye @grilla/core de ../core) y los estilos e
// íconos de la interfaz de docs/. Lo corre wrangler antes de publicar ([build] en wrangler.toml).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const here = (p) => new URL(p, import.meta.url);
mkdirSync(here('./public'), { recursive: true });

await build({
  entryPoints: [here('./web/app.ts').pathname],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  outfile: here('./public/app.js').pathname,
  logLevel: 'warning',
});
// Un solo CSS: los estilos base heredados de docs/ y los de la web (que van después y mandan).
writeFileSync(here('./public/app.css'), `${readFileSync(here('../docs/app.css'), 'utf-8')}\n${readFileSync(here('./web/web.css'), 'utf-8')}`);
mkdirSync(here('./public/fonts'), { recursive: true });
cpSync(here('./web/fonts'), here('./public/fonts'), { recursive: true });
cpSync(here('../docs/icons.js'), here('./public/icons.js'));
// Íconos de la app (para "Agregar a inicio" en el iPhone y Android): los mismos de docs/.
cpSync(here('../docs/img'), here('./public/img'), { recursive: true });
const manifest = JSON.parse(readFileSync(here('../docs/manifest.webmanifest'), 'utf-8'));
manifest.description = 'Tu lista de canales ordenada, con guía de programación, en tu reproductor.';
writeFileSync(here('./public/manifest.webmanifest'), JSON.stringify(manifest, null, 2));

// ?v= con el hash del contenido: el HTML nuevo nunca carga JS o CSS viejos de la caché.
const hash = createHash('sha256');
for (const f of ['app.js', 'app.css', 'icons.js', 'fonts/inter-latin.woff2']) hash.update(readFileSync(here(`./public/${f}`)));
const version = hash.digest('hex').slice(0, 10);
writeFileSync(here('./public/index.html'), readFileSync(here('./web/index.html'), 'utf-8').replaceAll('__VERSION__', version));
// El service worker (sin conexión) guarda la app de esta versión.
writeFileSync(here('./public/sw.js'), readFileSync(here('./web/sw.js'), 'utf-8').replaceAll('__VERSION__', version));
console.log(`public/ listo (v=${version})`);
