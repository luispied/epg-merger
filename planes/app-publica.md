# Grilla como app pública (iPhone, Apple TV y Android)

Prerrequisitos: `planes/etapa-0-generico.md` (✅) y `planes/etapa-1-web-sin-github.md` (Grilla web sin GitHub: guía compartida en R2, `@grilla/core` y Worker). La Etapa 0.5 (`planes/etapa-0-5-autoservicio.md`) es opcional.

**Decisiones:**
- Solo organizador: entrega URLs a TiviMate, IPTVX, etc.
- Procesamiento híbrido, sin cuenta: Llavero e iCloud en iOS; Auto Backup y exportación en Android.
- URL con token cifrado.
- React Native / Expo para iOS, iPadOS y Android; tvOS con react-native-tvos.
- Gratis al principio: Cloudflare R2 + Workers en plan gratis y GitHub Actions de un repo público del servicio.
- Grilla web convive y se migra por el backup.

**Arquitectura:**
- **Servicio compartido:** Actions diario → `merge_epgs.py` + paso compartido de `generate_playlist.py` (catálogo, logos, programación, guía por canal `epg/<hash>.xml.gz`) → R2.
- **App:**
  - credenciales en el Llavero;
  - baja la lista del proveedor directo;
  - coincidencias en el teléfono con `@grilla/core` (port TS de `channel_names.py`, `epg_index.py` y `match_channel`, con test de paridad ≥ 99 % contra Python);
  - ediciones sincronizadas por iCloud;
  - sube a R2 una configuración anónima (sin credenciales) → `cfgId`.
- **Worker:**
  - `GET /p/<cfgId>/<token>/playlist.m3u8`: token = credenciales cifradas AES-GCM con clave del Worker; se descifran al servir y no se guardan; baja la lista en vivo del proveedor (con failover) y le aplica la configuración (ver `planes/etapa-1-web-sin-github.md`);
  - `GET /s/<cfgId>/<token>/<stream_id>`: redirect al primer servidor sano del balanceador del proveedor;
  - `GET /p/<cfgId>/epg.xml.gz`: concatena la guía por canal desde R2.

**Fases:**
1. Etapa 0 (✅). Etapa 0.5 opcional.
2. **Etapa 1: Grilla web sin GitHub** (`planes/etapa-1-web-sin-github.md`): guía compartida en R2 y revisión de licencias, `@grilla/core` en TS con paridad, Worker de entrega y Grilla web sobre el Worker. Cubre lo que antes eran las fases 2, 3 y 4 de este plan.
3. App Expo sobre el mismo servicio: onboarding Xtream/M3U, credenciales en el Llavero, matching en el teléfono con `@grilla/core`, sincronización, copiar URLs, refresco en segundo plano, Apple TV de solo lectura e importación de la configuración de Grilla web.
4. Tiendas:
   - guías 5.2.2 y 5.2.3: "traé tu propia lista", sin contenido ni proveedores;
   - lista de demo legal para el revisor;
   - privacidad "Datos no recopilados";
   - Play: formulario de seguridad de datos;
   - si se cobra, compras dentro de la app.

**Riesgos:**
- Rechazo de Apple por la temática IPTV.
- Licencias de redistribución de las fuentes de EPG.
- Límites del plan gratis de Cloudflare: 100.000 pedidos por día y 10 GB.
