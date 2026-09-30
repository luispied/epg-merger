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
cpSync(here('../docs/app.css'), here('./public/app.css'));
cpSync(here('../docs/icons.js'), here('./public/icons.js'));
cpSync(here('./web/web.css'), here('./public/web.css'));

// ?v= con el hash del contenido: el HTML nuevo nunca carga JS o CSS viejos de la caché.
const hash = createHash('sha256');
for (const f of ['app.js', 'app.css', 'icons.js', 'web.css']) hash.update(readFileSync(here(`./public/${f}`)));
const version = hash.digest('hex').slice(0, 10);
writeFileSync(here('./public/index.html'), readFileSync(here('./web/index.html'), 'utf-8').replaceAll('__VERSION__', version));
console.log(`public/ listo (v=${version})`);
