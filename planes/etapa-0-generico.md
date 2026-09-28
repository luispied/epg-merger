# Etapa 0: hacer Grilla genérica (preparación para la app pública)

## Contexto
El plan de la app pública (`planes/app-publica.md`) necesita primero que el pipeline y Grilla dejen de estar hechos a la medida de tu proveedor y de tus fuentes de EPG. Esta etapa se hace en este repo, sin romper lo que usás hoy.

Hoy está atado a tu caso en tres lugares:
1. **Proveedor:** solo Xtream (`xtream_client.py`, `profiles.py`).
2. **Reglas de tu proveedor escritas en el código:**
   - en `generate_playlist.py`: `DIVIDER_CATEGORY_RE` (`▆░▒▓█`), `DIVIDER_SECTION_MAP` (PPV EVENTS, PAÍSES, DEPORTES…) y `DIVIDER_DISPLAY_OVERRIDE` (24/7);
   - en `docs/app.js`: `DIVIDER_RE`, `PPV_SECTION`, `PPV_EDITABLE_CATEGORIES` y `REVIEW_EXCLUDED_*` (General, 24/7);
   - `playlist_sections.json` completo.
3. **Fuentes de EPG:** `epg_urls.json` es una lista curada a mano para tus países. Otro usuario (por ejemplo, de Italia o de Filipinas) necesitaría otras, y hoy no hay forma de descubrirlas ni de elegirlas.

Resultado buscado:
- cualquier proveedor, Xtream o M3U;
- reglas como configuración con valores genéricos por defecto;
- un catálogo amplio de fuentes de EPG con sugerencias automáticas según los canales de cada usuario;
- tu configuración actual queda como un "preset" y produce exactamente el mismo resultado.

## Trabajo, en PRs separados (se mergean al estar en verde)

### 1. Guardar los planes en el repo ✅
- `planes/app-publica.md` y este archivo, en `planes/` (fuera de `docs/`, que se publica en GitHub Pages).

### 2. Proveedor agnóstico: Xtream y M3U ✅
- Nuevo `providers.py` con una interfaz común `list_channels()`, que devuelve `[{name, category, url, icon, epg_channel_id}]` y las categorías en el orden del proveedor.
  - **`XtreamProvider`:** envuelve `get_live_streams`, `get_live_categories` y `build_stream_url` de `xtream_client.py` (failover entre servidores incluido).
  - **`M3UProvider`:** baja o lee un M3U y parsea `#EXTINF` (`tvg-id`, `tvg-name`, `tvg-logo`, `group-title`) más la URL de stream tal cual. El orden de categorías es el de aparición.
- `profiles.py`: cada perfil acepta `"type": "xtream" | "m3u"`, con Xtream por defecto para compatibilidad. M3U usa `"url"`.
- `generate_for_profile` (`generate_playlist.py`) usa el proveedor en vez de llamar a Xtream directo. El fallback `epg_channel_id` y `tvg-id` del M3U se aprovechan igual que hoy.
- **Tests:** fixture M3U con `group-title` y `tvg-id` que genera lista, guía y reporte de punta a punta. Los tests actuales de Xtream siguen sin cambios.

### 3. Reglas del proveedor como configuración ✅
> Hecho con un solo archivo: `provider_rules.json` del repo *es* el preset del proveedor actual (sin el archivo, todo genérico); no hizo falta `presets/`.

- Nuevo `provider_rules.json` con valores genéricos por defecto: sin separadores especiales, secciones = categorías en el orden del proveedor, nada excluido. Campos:
  - `dividers`: patrón, mapa a sección y nombre visible;
  - `event_sections`: secciones de eventos sueltos que ninguna guía cubre (hoy "PPV EVENTS", con la excepción de "PPV DAZN");
  - `no_epg`: categorías, secciones y patrones que no necesitan guía (hoy General y 24 7).
- **Preset de tu proveedor:** `presets/luis.json` con exactamente lo que hoy está en el código y en `playlist_sections.json`, para que tu resultado no cambie.
- `generate_playlist.py` lee las reglas en lugar de las constantes. `is_divider_category`, `_divider_key` y `classify_section` pasan a recibirlas.
- El workflow publica `provider_rules.json` en la branch `data`. `docs/app.js` lo lee y reemplaza `DIVIDER_RE`, `PPV_SECTION`, `PPV_EDITABLE_CATEGORIES` y `REVIEW_EXCLUDED_*`.
- **En la interfaz (Configuración → Categorías):** junto al switch de visibilidad, una opción por categoría "No necesita EPG". Se guarda en `xtream_channel_map.json` como `no_epg_categories` y así cada usuario decide, en lugar de General y 24/7 fijos.

### 4. Catálogo amplio de fuentes de EPG
- `epg_sources_catalog.json` con todas las fuentes gratuitas conocidas. Por fuente:
  - `id`, `url`, `country`, `provider`;
  - `status` (`fresh` / `stale` / `down`), `last_checked`;
  - `channels` y `programmes_24h`.
- `tools/discover_epg_sources.py`, que automatiza lo que hice a mano esta semana:
  - lee el índice de epgshare01 (~100 archivos);
  - prueba los nombres de open-epg por país (`<pais>`, `<pais>1..N`, con redirect a `www`);
  - prueba iptv-epg.org (`epg-<cc>.xml.gz`) y una lista curada de repos (acidjesuz, davidmuma, programadorx…);
  - baja cada una, cuenta canales y marca `stale` si no tiene programación en las próximas 24 h. Así se descartan solas las abandonadas, como globetvapp o XML-EPG-LAT.
- Workflow semanal `discover-sources.yml` que actualiza el catálogo en la branch `data`.
- `epg_urls.json` pasa a ser **la selección del usuario**: referencias a ids del catálogo, más URLs propias y `active` / `inactive_reason` (ya existe). `load_sources` resuelve los ids contra el catálogo y el formato actual sigue funcionando.

### 5. Sugerencias y uso de fuentes según los canales de cada usuario
- `tools/source_coverage.py`, que formaliza los scripts de análisis de esta semana:
  - **países detectados:** banderas, prefijos (`AR|`, `CR|`) e idiomas de los canales del proveedor, con `flag_to_country_code` y `strip_display_prefix` de `channel_names.py`;
  - **candidatas:** fuentes `fresh` del catálogo para esos países;
  - **evaluación:** con el matcher real (`EpgIndex`, `match_channel`) mide cuántos canales visibles gana cada candidata y cuántos cambian, igual que el análisis de las 83 fuentes;
  - **sin uso:** fuentes activas que no usa ningún canal visible, candidatas a quedar inactivas.
- El workflow publica `sources_report.json` en `data` con el uso por fuente y las sugerencias.
- **En la interfaz (Configuración → Fuentes de EPG):**
  - lista de activas e inactivas, con cuántos canales usa cada una;
  - switch para activarla o desactivarla, que escribe `epg_urls.json` por la API como el mapa de canales;
  - sección "Sugeridas para tus canales" con la ganancia estimada.

## Archivos clave
- **Nuevos:**
  - `providers.py`, `provider_rules.json`, `presets/luis.json`;
  - `epg_sources_catalog.json`;
  - `tools/discover_epg_sources.py` y `tools/source_coverage.py`;
  - `.github/workflows/discover-sources.yml`;
  - `planes/*.md`.
- **A modificar:**
  - `generate_playlist.py`, `profiles.py`, `merge_epgs.py` (`load_sources` con catálogo);
  - `docs/app.js`, `docs/index.html`, `docs/types.d.ts`;
  - `.github/workflows/merge-epgs.yml` (publicar reglas y reporte de fuentes);
  - `README.md`.
- **A reutilizar:**
  - `EpgIndex`, `match_channel` y `ScheduleCollector` (streaming);
  - `load_epg_channels` / `iter_programmes` para medir cobertura sin cargar todo en memoria;
  - `epg_http.download_all`;
  - `applyChanges` y `withChannelMap` en la interfaz.

## Verificación
- **Sin regresión para vos:**
  - con `presets/luis.json`, el `match_report` y la playlist de la próxima corrida coinciden con la anterior (mismos `chosen`, grupos y orden);
  - se compara el reporte publicado antes y después de cada PR.
- **Proveedor M3U:** test de punta a punta con fixture, y prueba real con una lista pública legal (iptv-org de un país).
- **Reglas genéricas:** sin `provider_rules.json`, el pipeline genera secciones = categorías en orden y no rompe. La interfaz sin reglas muestra todo y no oculta nada.
- **Catálogo:** `discover_epg_sources.py` con HTTP simulado en tests, y corrida real que liste más de 150 fuentes con estado. Las que ya sabemos desactualizadas quedan `stale`.
- **Cobertura:** `source_coverage.py` sobre tu reporte reproduce el análisis manual (las mismas 24 sin uso y las mismas ganancias de las 8 nuevas).
- **Siempre:** 104 tests + los nuevos, `tsc -p docs`, chequeo de versiones de assets y Playwright de las pantallas nuevas.
