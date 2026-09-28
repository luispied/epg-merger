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
- **Actualización:** la lista de canales guardada se refresca cada vez que la persona abre
  Grilla (y con el refresco en segundo plano de la app, más adelante). **Opcional**, con
  consentimiento explícito: guardar las credenciales cifradas para que un cron diario
  detecte canales nuevos sin abrir Grilla.
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
  - `GET /p/<cfgId>/<token>/playlist.m3u8` — arma la playlist desde la configuración y
    las credenciales descifradas del token;
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
- Credenciales: solo dentro del token del link, cifradas; el Worker no las guarda (salvo la
  opción explícita de refresco diario, cifradas en reposo).
- La clave de edición nunca viaja en los links de reproducción.
- `POST /api/provider/list`: sin logs del cuerpo, límite por IP para que no sea un proxy
  abierto.
- Los links siguen siendo "inadivinables, no privados" (como un gist): Grilla lo explica al
  copiarlos.

## Costos y límites (plan gratis de Cloudflare)
- Workers: 100.000 pedidos por día, 10 ms de CPU por pedido (por eso el matching va en el
  navegador).
- R2: 10 GB y egreso gratis; la guía compartida ocupa ~200 MB por día.
- D1: 5 GB. Si se supera algo, Workers pago (~5 USD/mes) resuelve CPU y pedidos.

## Verificación
- Paridad del matcher TS ≥ 99 % contra Python.
- Tu configuración importada da la misma playlist (canales, orden, grupos) y los mismos EPG
  que la corrida de GitHub.
- Un usuario de prueba con una lista M3U pública legal (iptv-org de un país) llega a sus
  links y los carga en un reproductor.
- Tests del Worker; Playwright del onboarding y de "Tus links".
