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

## Puesta en marcha (una vez)

1. **La clave:** 32 bytes al azar en base64. Se puede generar con `openssl rand -base64 32`
   en una terminal, o pegando esto en la consola del navegador (F12 → Console):
   `btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))`.
   No la pegues en ningún chat ni archivo.
2. Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → `epg-merger`:
   - *Project name*: `grilla`;
   - *Root directory* (en Advanced): `worker`;
   - *Deploy command*: `npx wrangler deploy` (el que viene).

   Se publica en `https://grilla.<tu-subdominio>.workers.dev` y se vuelve a publicar solo en
   cada cambio de `main`.
3. En el Worker → **Settings → Variables and Secrets** → **Add** → tipo *Secret*, nombre
   `TOKEN_KEY`, valor: la clave del paso 1.

   Si la clave se cambia, dejan de andar los links ya copiados.

El bucket `grilla` ya tiene que existir: el Worker lo usa por nombre (`wrangler.toml`).

## Desarrollo

```sh
npx -p typescript@5.9 tsc -p worker --noEmit   # tipos
node --test worker/test/*.test.ts              # tests, con R2, caché y proveedor simulados
```
