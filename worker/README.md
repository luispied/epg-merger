# Worker de Grilla

Servidor de Grilla web (Etapa 1, `planes/etapa-1-web-sin-github.md`) en Cloudflare Workers:
configuraciones anónimas, links de reproducción para TiviMate y compañía, redirect al servidor
sano del balanceador y la guía desde R2. Endpoints: ver el comentario de `src/index.ts`.

- **Credenciales:** viajan solo dentro del token del link, cifradas con AES-GCM y la clave del
  Worker (`TOKEN_KEY`), atadas a su configuración. No se guardan en R2 ni en la caché, y los
  errores no las incluyen.
- **Configuración:** `cfg/<cfgId>.json` en R2. Guarda las ediciones por canal y los servidores,
  sin usuario ni contraseña, junto con el hash de la clave de edición.
- **Lista en vivo:** la playlist se arma al pedirla con la lista del proveedor de ese momento.
  En Xtream se guarda 3 horas, sin credenciales ni URLs de stream. Si el proveedor no responde,
  sale la última que se pudo bajar.
- **Guía:** `epg/<cfgId>.xml.gz`, que arma la corrida diaria (`tools/config_epgs.py`).
- **Proveedores que bloquean Cloudflare:** el de Luis, por ejemplo, le responde 403 al Worker
  pero atiende a GitHub y a los reproductores. En esos casos la configuración lleva
  `provider.list: "upload"` y la lista la pone otro en R2 (`list/<cfgId>.json`, sin credenciales
  ni URLs):
  - **GitHub**, si tiene la cuenta en `XTREAM_PROFILES` (`refresh-lists.yml` y
    `tools/push_lists.py`, cada 10 minutos). El Worker y GitHub se encuentran por una huella de
    usuario y contraseña (`src/link.ts`): GitHub anota en `known/` las cuentas que tiene. Cuando
    alguien entra con una de esas cuentas, la web crea la configuración, el Worker la anota en
    `links/` y GitHub le sube la lista en su próxima corrida, y después cada 3 horas. La persona
    no tiene que hacer nada más.
  - **La persona**, si GitHub no la conoce: baja la lista con su navegador y la sube desde la
    web (`PUT /api/cfg/<cfgId>/list`).

  El redirect `/s/` sigue andando en los dos casos: el que se conecta al servidor es el
  reproductor, y para el Worker un servidor que responde 403 cuenta como vivo.

## La web (Grilla web)

`web/` es la interfaz: conectar el proveedor, cruzar los canales con la guía en el navegador
(con `@grilla/core`, el mismo matcher que la corrida de Python), corregir y copiar los links.
`build.mjs` la compila con esbuild a `public/`, junto con los estilos e íconos de `docs/`.
Cloudflare la sirve en la misma dirección del Worker (`[assets]` en `wrangler.toml`) y corre la
compilación sola antes de publicar (`[build]`).

- Si el proveedor no deja que el Worker baje la lista (403), la web le pide a la persona que
  la baje con su navegador (link `get.php` armado con sus datos) y la suba como archivo. Se
  sube sin URLs y la configuración queda en modo `list: "upload"`.
- La clave de edición queda en el navegador (`localStorage`) y se puede exportar como respaldo.
  Usuario y contraseña no se guardan: se piden para generar los links.
- La interfaz de GitHub (`docs/`) no cambia: sigue siendo el respaldo.

## Puesta en marcha (una vez)

1. **La clave:** 32 bytes al azar en base64. Se puede generar con `openssl rand -base64 32`
   en una terminal, o pegando esto en la consola del navegador (F12 → Console):
   `btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))`.
   No la pegues en ningún chat ni archivo.
2. Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → `epg-merger`:
   - *Project name*: `grilla`;
   - *Root directory* (en Advanced): `worker`;
   - *Deploy command*: `npx wrangler deploy` (el que viene).

   Se publica en `https://grilla.<tu-subdominio>.workers.dev` (hoy `https://grilla.grilla.workers.dev`;
   el subdominio se cambia en Workers & Pages → Subdomain, y con él cambian todos los links) y se vuelve a publicar solo en
   cada cambio de `main`.
3. En el Worker → **Settings → Variables and Secrets** → **Add** → tipo *Secret*, nombre
   `TOKEN_KEY`, valor: la clave del paso 1.

   Si la clave se cambia, dejan de andar los links ya copiados.

El bucket `grilla` ya tiene que existir: el Worker lo usa por nombre (`wrangler.toml`).

## Desarrollo

```sh
npx -p typescript@5.9 tsc -p worker --noEmit       # tipos del Worker
npx -p typescript@5.9 tsc -p worker/web --noEmit   # tipos de la web
node --test worker/test/*.test.ts                  # tests, con R2, caché y proveedor simulados
cd worker && npm install && node build.mjs         # compilar la web a public/
npx wrangler dev --local                           # todo junto en http://localhost:8787
# (con TOKEN_KEY en worker/.dev.vars y la guía en el R2 local:
#  npx wrangler r2 object put grilla/guide/index.json --file … --local)
```
