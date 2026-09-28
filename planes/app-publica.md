# Grilla como app pública (iPhone, Apple TV y Android)

Prerrequisitos: `planes/etapa-0-generico.md` (✅) y `planes/etapa-0-5-autoservicio.md` (cargar el proveedor y ver los links desde Grilla, sin tocar código).

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
  - `GET /p/<cfgId>/<token>/playlist.m3u8`: token = credenciales cifradas AES-GCM con clave del Worker; se descifran al servir y no se guardan; no llama al proveedor;
  - `GET /p/<cfgId>/epg.xml.gz`: concatena la guía por canal desde R2.

**Fases:**
1. Etapa 0 (✅) y Etapa 0.5: autoservicio en GitHub (asistente, proveedor desde Grilla, "Tus links"). Lo que se aprenda del asistente y de "Tus links" se reusa en el onboarding de la fase 5.
2. Servicio compartido en R2 y revisión de licencias de fuentes de EPG.
3. `@grilla/core` en TS con paridad.
4. Worker de entrega.
5. App Expo, con onboarding Xtream/M3U, sincronización, copiar URLs, refresco en segundo plano, Apple TV de solo lectura e importación del backup de Grilla web.
6. Tiendas:
   - guías 5.2.2 y 5.2.3: "traé tu propia lista", sin contenido ni proveedores;
   - lista de demo legal para el revisor;
   - privacidad "Datos no recopilados";
   - Play: formulario de seguridad de datos;
   - si se cobra, compras dentro de la app.

**Riesgos:**
- Rechazo de Apple por la temática IPTV.
- Licencias de redistribución de las fuentes de EPG.
- Límites del plan gratis de Cloudflare: 100.000 pedidos por día y 10 GB.
