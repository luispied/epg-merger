# Relay de Grilla

Servicio chico que pide al proveedor IPTV lo que el Worker de Cloudflare no puede pedir (el proveedor bloquea
las IPs de Cloudflare). Reemplazó al secret `XTREAM_PROFILES` de GitHub para listas y pruebas: el Worker ya tiene las credenciales de
cada persona (cifradas en sus links) y se las manda al relay en cada pedido; el relay las usa y las descarta.

## Qué hace
| Pedido | Respuesta |
|---|---|
| `POST /v1/list` `{servers, username, password}` | `{server, channels}` (la lista, sin URLs) |
| `POST /v1/account` `{servers, username, password}` | `{server, account}` (vencimiento, conexiones, zona horaria del panel) |
| `POST /v1/probe` `{servers, username, password, channels:[{id, ext}]}` | `{server, account, results, aborted}` (hasta 60 canales) |
| `GET /health` | `{ok: true}` |

Todos los `POST` llevan `Authorization: Bearer <RELAY_SECRET>`.

## Seguridad
- No guarda nada y no escribe usuario, contraseña ni URLs en el log.
- Solo habla con servidores públicos (http/https; rechaza IPs privadas, locales y de enlace).
- Un pedido por cuenta a la vez y hasta 4 en total; topes de tamaño, de canales y de tiempo.
- Sirve por HTTPS (lo pone la plataforma); `RELAY_SECRET` debe tener 32 caracteres como mínimo.

## Antes de elegir dónde: ¿esa plataforma llega al proveedor?
El proveedor bloquea por IP, y no se sabe de antemano qué plataformas bloquea. `relay/probe_provider.py` lo prueba sin
credenciales: pide `player_api.php` sin usuario ni contraseña, y un origen aceptado recibe la respuesta de la API (aunque diga
«no autorizado»), mientras que uno bloqueado ve la conexión cortada o un 403. Se corre **en** la plataforma candidata, con la
dirección del proveedor en una variable de entorno (no se escribe en ningún chat ni archivo):

    PROVIDER_URL=http://servidor.ejemplo:8080 python3 probe_provider.py     # ALCANZABLE / BLOQUEADO / DUDOSO

Ejemplos: en Fly.io, `fly machine run python:3.12-slim --shell` (o `fly ssh console` en una app ya creada) y pegar el script; en un
VPS o una VM de Oracle, por SSH. La plataforma tiene que dar ALCANZABLE, como la corrida de GitHub. Si ninguna nube lo da, una
máquina en tu casa (IP residencial) con Docker suele andar, aunque no esté prendida siempre.

## Publicarlo (ejemplo con Fly.io)
1. Generá el secret **en tu computadora**, sin pegarlo en ningún chat: `openssl rand -base64 48`.
2. `fly launch --no-deploy --dockerfile relay/Dockerfile` (desde la raíz del repo), `fly secrets set RELAY_SECRET=…`, `fly deploy`.
3. En el Worker (panel de Cloudflare → Settings → Variables, o `wrangler secret put`): `RELAY_URL` (la URL HTTPS del relay)
   y `RELAY_SECRET` (el mismo valor).
4. Probar: `curl https://<relay>/health`.

Cualquier plataforma que corra un contenedor sirve (un VPS con Docker, Oracle Cloud gratis, etc.): lo único que
importa es que la IP de salida no esté bloqueada por el proveedor.

## Sin relay
Si el Worker no tiene `RELAY_URL` y `RELAY_SECRET`, la lista la sube la persona (desde el navegador o con
`tools/grilla_home.py`) y no hay prueba de canales caídos ni datos de la cuenta. La corrida de GitHub ya no baja listas.
