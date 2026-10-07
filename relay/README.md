# Relay de Grilla

Servicio chico que pide al proveedor IPTV lo que el Worker de Cloudflare no puede pedir (el proveedor bloquea
las IPs de Cloudflare). Reemplaza al secret `XTREAM_PROFILES` de GitHub: el Worker ya tiene las credenciales de
cada persona (cifradas en sus links) y se las manda al relay en cada pedido; el relay las usa y las descarta.

## Qué hace
| Pedido | Respuesta |
|---|---|
| `POST /v1/list` `{servers, username, password}` | `{server, channels}` (la lista, sin URLs) |
| `POST /v1/account` `{servers, username, password}` | `{server, account}` (vencimiento, conexiones) |
| `POST /v1/probe` `{servers, username, password, channels:[{id, ext}]}` | `{server, account, results, aborted}` (hasta 60 canales) |
| `GET /health` | `{ok: true}` |

Todos los `POST` llevan `Authorization: Bearer <RELAY_SECRET>`.

## Seguridad
- No guarda nada y no escribe usuario, contraseña ni URLs en el log.
- Solo habla con servidores públicos (http/https; rechaza IPs privadas, locales y de enlace).
- Un pedido por cuenta a la vez y hasta 4 en total; topes de tamaño, de canales y de tiempo.
- Sirve por HTTPS (lo pone la plataforma); `RELAY_SECRET` debe tener 32 caracteres como mínimo.

## Publicarlo (ejemplo con Fly.io)
1. Generá el secret **en tu computadora**, sin pegarlo en ningún chat: `openssl rand -base64 48`.
2. `fly launch --no-deploy --dockerfile relay/Dockerfile` (desde la raíz del repo), `fly secrets set RELAY_SECRET=…`, `fly deploy`.
3. En el Worker (panel de Cloudflare → Settings → Variables, o `wrangler secret put`): `RELAY_URL` (la URL HTTPS del relay)
   y `RELAY_SECRET` (el mismo valor).
4. Probar: `curl https://<relay>/health`.

Cualquier plataforma que corra un contenedor sirve (un VPS con Docker, Oracle Cloud gratis, etc.): lo único que
importa es que la IP de salida no esté bloqueada por el proveedor.

## Sin relay
Si el Worker no tiene `RELAY_URL` y `RELAY_SECRET`, todo sigue como antes (la corrida de GitHub).
