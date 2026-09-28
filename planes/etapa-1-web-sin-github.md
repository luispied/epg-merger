# Etapa 1: Grilla web sin GitHub

Prerrequisito: `planes/etapa-0-generico.md` (✅). Reemplaza como camino principal a la
Etapa 0.5 (`planes/etapa-0-5-autoservicio.md`), que queda **opcional**. Es la base de la app
pública (`planes/app-publica.md`): la app pasa a ser otra cara del mismo servicio.

## Contexto
Hoy usar Grilla depende de tu repo (ediciones y workflow), de un gist por persona (la
playlist) y de un token de GitHub (para guardar desde la interfaz). Otra persona no puede
usarlo sin su propia cuenta de GitHub y sin configuración técnica.

Resultado buscado: **cualquiera entra a la web, carga su Xtream o su M3U, corrige lo que
quiera y copia dos links** (playlist y EPG) para su reproductor. Sin cuenta, sin GitHub y
gratis para el servicio mientras entre en los planes gratuitos.

## Decisiones
- **Sin cuenta:** cada persona tiene una **configuración anónima** (`cfgId`) y una **clave de
  edición** que queda en su navegador (exportable, como el backup de hoy). Quien tiene la
  clave edita; los links de reproducción no la llevan.
- **Credenciales fuera del servidor:** van cifradas (AES-GCM, clave del Worker) dentro del
  link de la playlist: `…/p/<cfgId>/<token>/playlist.m3u8`. El Worker las descifra solo para
  armar las URLs de stream al servir y no las guarda.
- **Matching en el navegador:** el Worker baja la lista del proveedor **de paso** (el
  navegador no puede, por CORS y http), sin guardarla ni registrarla; el cruce con la guía
  se hace en el navegador con `@grilla/core` (port a TypeScript del matcher de Python).
  Así el Worker entra en el plan gratis (10 ms de CPU por pedido).
- **Lista en vivo al servir, sin abrir Grilla:** cuando el reproductor (TiviMate) pide la
  playlist, el Worker ya tiene las credenciales (vienen en el token del link), así que baja
  la lista **en ese momento** del proveedor y le aplica lo guardado:
  - canales conocidos (por nombre crudo, como hoy los overrides) → su EPG elegido,
    renombre, categoría y ocultos;
  - canales nuevos (por ejemplo los eventos PPV del día, que el proveedor rota) → salen tal
    cual, sin EPG, igual que hoy; los que desaparecieron, simplemente no salen;
  - la lista ya procesada (sin credenciales ni URLs de stream: solo nombre, categoría,
    `stream_id`) se cachea unas horas por configuración, para no pedirla en cada refresco
    y no pasar el límite de CPU; si el proveedor no responde, se sirve la última cacheada.
  El matching pesado de los canales nuevos contra la guía sigue siendo en el navegador al
  abrir Grilla; en el día a día la playlist queda siempre al día. **No hace falta guardar
  credenciales en el servidor.**
- **Balanceador del proveedor (Xtream):** la configuración guarda la lista de servidores
  (sin credenciales) y se usa en dos lugares:
  - **al bajar la lista:** se prueba cada servidor en orden, como hoy `xtream_client.py`;
  - **al reproducir:** hoy la playlist queda armada con el servidor que respondió al
    generar, y si ese se cae durante el día TiviMate no puede saltar a otro. Con el Worker,
    cada canal de la playlist apunta a `…/s/<cfgId>/<token>/<stream_id>.<ext>` y el Worker
    responde con un **redirect 302 al primer servidor sano**, con las mismas credenciales.
    El estado de cada servidor (sano / caído) se cachea un par de minutos para que cambiar de
    canal no sume demoras. El video nunca pasa por el Worker, solo el redirect.
  - Un perfil puede elegir "URLs directas" (sin redirect) por si algún reproductor no sigue
    redirects; en ese caso se arma con el servidor sano del momento, como hoy.
- **EPG compartido:** una sola corrida diaria para todo el servicio (GitHub Actions de un
  repo público del servicio, o tu repo mientras tanto): `merge_epgs.py` + catálogo + guía
  por canal a R2. Es infraestructura, no algo de cada usuario.
- **Grilla de hoy** (con GitHub) sigue andando para vos hasta migrar con un import.

## Arquitectura
- **Servicio compartido (diario):** `merge_epgs.py` → `epg/<hash de channel_id>.xml.gz` por
  canal, `epg_catalog.json`, `epg_icons.json`, `schedule/` y el índice que usa `@grilla/core`
  → Cloudflare R2.
- **Worker (Cloudflare):**
  - `POST /api/provider/list` — baja la lista del proveedor (Xtream `player_api` o M3U) y
    la devuelve normalizada (`{name, category, url, icon, epg_channel_id}` como
    `providers.py`), sin guardar nada; límite de tamaño y de pedidos por IP;
  - `POST /api/cfg` → `{cfgId, editKey}`; `GET/PUT /api/cfg/<cfgId>` con `editKey` — la
    configuración: canales del proveedor (sin URLs ni credenciales), elección de EPG por
    canal, renombres, categorías, ocultos, reglas y fuentes;
  - `POST /api/token` — cifra las credenciales y devuelve el `token` para los links;
  - `GET /p/<cfgId>/<token>/playlist.m3u8` — baja la lista en vivo del proveedor (con
    failover entre servidores y caché de unas horas), le aplica la configuración y arma la
    playlist; los streams apuntan a `/s/…` (o directo al servidor sano, según el perfil);
  - `GET /s/<cfgId>/<token>/<stream_id>.<ext>` — redirect 302 al primer servidor sano del
    balanceador, con las credenciales del token;
  - `GET /p/<cfgId>/epg.xml.gz` — concatena de R2 la guía de los canales elegidos.
- **Almacenamiento:** Cloudflare D1 o KV para configuraciones (unos KB cada una), R2 para
  la guía compartida.
- **Grilla web:** la misma interfaz de hoy, con una capa de datos nueva: en vez de leer la
  branch `data` y escribir por la API de GitHub, lee y escribe en el Worker. `applyChanges`,
  Deshacer, selección múltiple, Fuentes de EPG y Categorías siguen igual.

## Trabajo, en PRs separados
1. **`@grilla/core` en TypeScript:** port de `channel_names.py`, `epg_index.py`,
   `match_channel` y las reglas del proveedor, con **test de paridad ≥ 99 %** contra Python
   sobre tus reportes reales (mismos `chosen`).
2. **Guía compartida en R2:** el workflow publica la guía por canal y los índices a R2
   además de lo de hoy. Revisión de licencias de las fuentes de EPG (antes de abrirlo a
   otros).
3. **Worker:** los endpoints de arriba, con tests (Miniflare), límites por IP y sin logs de
   credenciales.
4. **Grilla web sobre el Worker:** onboarding (Xtream / M3U), matching en el navegador,
   "Tus links" con Copiar y QR, capa de datos nueva, import de tu configuración actual
   (`xtream_channel_map.json` + fuentes).
5. **Migración tuya:** importar tu configuración, comparar la playlist y la guía con las de
   GitHub (mismos canales, mismos EPG) y cambiar los links en tus reproductores.

## Seguridad
- Credenciales: solo dentro del token del link, cifradas; el Worker no las guarda en ningún
  caso (ni en la caché de la lista, que no lleva URLs de stream).
- La clave de edición nunca viaja en los links de reproducción.
- `POST /api/provider/list`: sin logs del cuerpo, límite por IP para que no sea un proxy
  abierto.
- Los links siguen siendo "inadivinables, no privados" (como un gist): Grilla lo explica al
  copiarlos.

## Costos y límites (plan gratis de Cloudflare)
- Workers: 100.000 pedidos por día, 10 ms de CPU por pedido (por eso el matching va en el
  navegador). Cada cambio de canal con redirect es un pedido: una persona que zapea mucho
  hace unos cientos por día, así que alcanza para decenas de usuarios; aplicar la
  configuración a ~3.000 canales puede rozar los 10 ms, de ahí la caché de la lista
  procesada. Si no alcanza, Workers pago (~5 USD/mes).
- R2: 10 GB y egreso gratis; la guía compartida ocupa ~200 MB por día.
- D1: 5 GB. Si se supera algo, Workers pago (~5 USD/mes) resuelve CPU y pedidos.

## Verificación
- Paridad del matcher TS ≥ 99 % contra Python.
- Tu configuración importada da la misma playlist (canales, orden, grupos) y los mismos EPG
  que la corrida de GitHub.
- Un usuario de prueba con una lista M3U pública legal (iptv-org de un país) llega a sus
  links y los carga en un reproductor.
- Tests del Worker; Playwright del onboarding y de "Tus links".
- **Lista en vivo:** con un proveedor simulado, un canal nuevo aparece en la playlist sin
  abrir Grilla y uno que desaparece deja de salir; si el proveedor no responde, sale la
  última cacheada.
- **Balanceador:** con el primer servidor caído, la lista se baja del segundo y `/s/…`
  redirige al segundo; cuando el primero vuelve, se lo usa de nuevo. Prueba real en TiviMate
  de que sigue el redirect.
