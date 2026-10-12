# Pipeline de EPG: de las fuentes al matching

Referencia de la parte de Python del repo: cómo se fusionan las fuentes de guía, cómo se decide qué guía le toca a cada
canal y qué archivos de configuración mandan. La vista general del sistema está en [`arquitectura.md`](arquitectura.md);
la interfaz y la API, en [`../worker/README.md`](../worker/README.md).

La parte cara (fusionar las fuentes y decidir qué `tvg-id` le corresponde a cada canal) es idéntica para todo el
mundo y se hace **una sola vez** por día. Lo que cambia entre personas se deriva de eso en una pasada
(la guía y el índice por hora de cada configuración, ver `arquitectura.md`).

`generate_playlist.py` lee `merged.xml.gz` en streaming (unos 1,3 GB de XML y 2 millones de programas) en vez de
cargarlo entero: una pasada por los canales para indexar y otra por los programas. Usa unos 600 MB de memoria en
lugar de más de 10 GB, que en un runner cargado hacían que la corrida se arrastrara por swap (de 8 a más de 30
minutos).

## Fuentes EPG (`epg_urls.json`)

```json
{ "id": "acidjesuz-us", "url": "https://.../US_guide.xml.gz", "country": "us" }
```

- **`id`** identifica la fuente y queda estampado en cada canal de `merged.xml.gz` como
  atributo `source`. Así `playlist_sections.json` puede preferir fuentes concretas por sección
  sin volver a descargar ni re-parsear nada, y las etiquetas de las alternativas muestran la
  procedencia real en vez de adivinarla desde el `channel_id`.
- **`country`** (opcional) es el país que cubre la fuente. Omitirlo significa multi-país.
- **`priority`** (opcional, menor = mejor) por defecto es la posición en la lista: ante un canal
  duplicado gana la fuente que aparece primero.
- **`active`: false** deja la fuente inactiva sin borrarla (no se descarga), con el motivo en
  `inactive_reason`. Anteponer `#` a la `url` también la deshabilita. La prioridad de las demás
  no cambia: sigue siendo su posición en la lista.

### Catálogo de fuentes (`epg_sources_catalog.json`)

`tools/discover_epg_sources.py` recorre los proveedores públicos de EPG y arma un catálogo de
todas las fuentes gratuitas que encuentra, con su país y su estado:

- **epgshare01:** lee el índice completo del directorio.
- **open-epg:** prueba `<país>`, `<país>1`, `<país>2`… para cada país conocido; open-epg
  responde 200 vacío cuando un archivo no existe, así que se mira que venga contenido.
- **iptv-epg.org:** prueba `epg-<código>.xml.gz` por país.
- **Repos sueltos** ya conocidos (acidjesuz, davidmuma, programadorx y algunos abandonados, para
  notar si reviven).

Cada archivo se baja y se evalúa en streaming: `fresh` si tiene programación en las próximas
24 h, `stale` si responde pero su guía es vieja, `down` si no se pudo bajar o no es XMLTV. Corre
todos los lunes (`.github/workflows/discover-sources.yml`) y commitea el catálogo en `main` si
cambió.

En `epg_urls.json` una fuente del catálogo se puede agregar solo por id
(`{ "id": "openepg-italy1" }`): la URL y el país salen del catálogo, y lo que declare la entrada
manda sobre él.

Antes de sumar una fuente conviene medir qué aporta: que tenga programación vigente (hay
repositorios públicos que dejaron de actualizarse hace meses) y cuántos canales sin EPG pasa a
cubrir sin cambiarle el EPG a los que ya estaban bien. Las fuentes de Brasil, República
Dominicana, Guatemala, Honduras, Puerto Rico, El Salvador y Venezuela del final de la lista se
sumaron así, después de las demás para no desplazar a las existentes; los pocos canales que
cambiaban para peor quedaron fijados con un override en `xtream_channel_map.json`.

Con las categorías ocultas en cuenta, las fuentes que no le dan guía a ningún canal visible
quedan inactivas (`"active": false`). Al revisarlo conviene volver a correr el matcher sin
ellas: sacar canales del índice cambia el peso de las palabras y puede mover algún match; los
que cambiaban para peor también quedaron fijados con un override.

### Uso de cada fuente y sugerencias (`tools/source_coverage.py`)

Después de generar las playlists, el workflow corre `tools/source_coverage.py`, que deja en
`out/sources_report.json` (también en el artifact `match-reports` de la corrida; no se publica en R2):

- **uso por fuente:** cuántos canales visibles (sin ocultos, categorías ocultas ni separadores)
  toman su guía de cada fuente y cuántas veces aparece como alternativa; las activas que no usa
  nadie quedan en `unused_active`;
- **países detectados** en los canales visibles que siguen sin guía (prefijo `AR|`, bandera de
  la categoría, país en el nombre), sin contar los que no la necesitan (`no_epg` de
  `provider_rules.json`, categorías marcadas "Sin guía", eventos sueltos, "forzar sin EPG");
- **sugerencias:** hasta 20 fuentes `fresh` del catálogo de esos países que todavía no están en
  `epg_urls.json`, repartidas por turnos entre países. Se bajan, se suman al índice sus canales
  con programación en las próximas 24 h y se corre el matcher real sobre los canales sin guía:
  la ganancia es cuántos quedarían con guía firme (puntaje ≥ 0.9) y cuántos con una dudosa.
  Solo se sugieren las que suman algo.

El paso tiene `continue-on-error`: si falla, la corrida sigue. En la interfaz,
**Configuración → Fuentes de EPG** muestra las activas (con cuántos canales usan cada una, las
sin uso primero), las inactivas y las sugeridas: el switch escribe `"active": false` con
`"inactive_reason": "desactivada desde Grilla"` en `epg_urls.json` (o lo saca al reactivarla) y
**Agregar** suma `{ "id": ... }` del catálogo. Son commits como los del mapa de canales, con
*Deshacer*, y se aplican en la próxima corrida.

El formato viejo (`"urls": ["...", "..."]`) sigue funcionando: el `id` se deriva del nombre de
archivo y la prioridad es la posición.

### Fuentes automáticas (`tools/auto_sources.py`)

Para cubrir cualquier país del catálogo sin bajar sus 548 fuentes todos los días, la corrida
activa sola las fuentes que alguien necesita y retira las que nadie usa:

1. **Demanda:** los canales visibles sin guía de los perfiles de la corrida y de cada
   configuración de Grilla web (su `cfg/<cfgId>.json` con la lista guardada `list/<cfgId>.json`
   en R2; las listas M3U no se guardan, así que no suman demanda).
2. **Candidatas:** hasta 12 fuentes `fresh` del catálogo de los países que faltan, por turnos.
   Nunca una que esté en `epg_urls.json` (activa o desactivada a mano: lo manual manda), ni una
   de más de 25 MB, ni una medida hace menos de 7 días que no sumó nada.
3. **Medición:** el matcher real sobre hasta 6000 canales sin guía (por turnos entre países),
   como en las sugerencias de arriba. La misma pasada mide cuánto sumarían todavía las
   automáticas ya activas.
4. **Decisión:** se activan las que dan al menos un canal con guía firme y rinden ~1 canal cada
   5 MB o más (una guía dudosa vale ¼), las que más rinden primero, con tope de 4 nuevas por
   corrida, 30 activas y 120 MB entre todas. Una automática que durante 7 corridas seguidas no
   usa nadie (perfiles y configuraciones) ni sumaría nada se retira.

El estado está en R2 (`state/auto_sources.json`, privado). La corrida siguiente lo baja antes de
fusionar (`auto_sources.py pull` → `auto_sources.json`) y `merge_epgs.py` suma esas fuentes
detrás de las de `epg_urls.json` (prioridad 1000 en adelante): una fuente activada hoy entra en
la guía mañana. Las configuraciones de Grilla web toman la guía nueva la próxima vez que se
abren (el cruce automático corre en el navegador).

### Deduplicación

Un canal presente en varias fuentes (los 7 archivos de España comparten decenas de
`channel_id`) tomaba antes la programación de **todas**, quedando repetida y solapada en la
guía. Ahora los programas se deduplican por `(canal, start)`: ante colisión gana la fuente más
prioritaria, y los horarios que ésa no cubre los siguen aportando las demás, así deduplicar no
cuesta días de guía.

El merge corre en streaming: cada fuente se lee elemento por elemento y la deduplicación se
hace en una base SQLite temporal en disco. Antes armaba todo en memoria y con ~2 M de programas
pasaba los 14 GB (el runner tiene 16 GB); así usa ~1,4 GB aunque la guía llegue a 3 M de
programas. En **Fuentes de EPG** las de más de 20 MB se marcan como *pesadas*, con su tamaño y
cantidad de programas, para ver el costo antes de sumarlas.

## Cómo se matchea un canal con su EPG

Antes de tocar el nombre, se le saca el prefijo que el proveedor antepone y que no aporta nada
al verlo en el reproductor: código de país + `|` o `:` (`UY|`, `PT|`, `ES:`, `CL|`, `BR|`,
`AR|`, `USA|`, `E|`, `S|`, `D|`, `Y|`), número de evento (`EVENTS 01:`) o `24` + una letra
(`24P`).
Si el prefijo era un código de país reconocido, ese país sigue sumando al matching aunque ya
no esté en el nombre. Los overrides de `xtream_channel_map.json` siguen buscándose por el
nombre **crudo** (con el prefijo), porque es lo que se copia del panel de Xtream.

El nombre del canal se descompone en **núcleo + señales** en vez de irle borrando pedazos:

| Nombre en Xtream | Núcleo | Señales |
|---|---|---|
| `TBS -EN` | `tbs` | idioma `en` → se prefieren fuentes de EE.UU./UK/Canadá |
| `Warner TV Costa Rica` | `warner tv` | país `cr` |
| `ESPN 1 ARG` | `espn 1` | país `ar` |
| `TBS East HD` | `tbs` | región `east`, calidad `hd` |

Después se puntúa cada candidato por **solapamiento de tokens pesado por IDF**: los tokens que
aparecen en miles de canales (`tv`, `channel`, `hd`) pesan casi nada por su propia estadística,
y los raros (`warner`, `laff`) pesan mucho. Eso reemplaza a la lista manual de sufijos a
ignorar y hace que `"E! Entertainment Television"` matchee `"E! Entertainment"` sin necesidad
de mutilar el nombre, y que `"TV Land"` conserve su `TV`.

Sobre ese puntaje base ajustan las demás señales: fuente preferida por la sección, país
(coincidir suma, diferir penaliza fuerte), región y prioridad de fuente como desempate.

Si hay perfiles configurados (opcional, ver abajo), cada corrida deja un **`out/<perfil>/match_report.json`** con el candidato elegido, su puntaje,
el motivo y las alternativas descartadas. No contiene URLs de stream, así que se puede guardar
y diffear entre corridas para ver si un cambio de heurística mejoró o empeoró el matching.

### Diccionario de canales de iptv-org (`channel_db.py`)

El workflow baja `iptv_channels.json` de la API de [iptv-org/database](https://github.com/iptv-org/database)
(dominio público): ~30 mil canales con sus nombres alternativos y país. Cuando un canal no
encuentra guía por su nombre, el matcher prueba con los otros nombres del mismo canal ("13C" =
"Canal 13 Cable") y acepta solo un resultado "Bien" del mismo país. Si el archivo no está,
todo funciona igual sin él.

### Preferencias aprendidas de los overrides (`tools/learn_preferences.py`)

Muchos overrides repiten un criterio ("en PPV DAZN siempre elijo la guía de programadorx-cl").
La herramienta prueba, para cada categoría con overrides, preferir cada fuente que aparece en
ellos y mide con el matcher real cuántos overrides pasaría a resolver solo, cuántos rompería y
qué canales sin override cambiarían. Con `--apply` escribe las seguras (sin roturas ni cambios)
en `playlist_sections.json` → `category_epg`, que suma fuentes preferidas por categoría a las de
la sección.

```
python tools/learn_preferences.py --merged merged.xml.gz --report out/luis/match_report.json
```

### Banco de prueba del matcher (`tools/match_benchmark.py`)

Mide qué tan bien asigna el EPG el matcher en listas que **no** son de este proveedor: copias
congeladas de listas públicas de iptv-org en `bench/lists/` y respuestas correctas en
`bench/labels/` (revisadas a mano; `"!id"` marca un id que se sabe incorrecto) más las que
salen del `tvg-id` de cada lista. Reporta cobertura, aciertos y precisión de "Bien" y
"Dudoso" por lista. Con `--luis <match_report>` mide además contra los overrides de Luis, y
con `--luis-save` / `--luis-compare` muestra exactamente qué canales suyos cambia un arreglo.
Corre en cada workflow (informativo) y localmente:

```
python tools/match_benchmark.py --merged merged.xml.gz
```

### El matcher en TypeScript (`core/`)

`@grilla/core` es el mismo matcher portado a TypeScript, para correrlo en el navegador (Etapa
1). Tiene que dar exactamente lo mismo que el de Python: **si se cambia el matcher de Python,
hay que hacer el mismo cambio en `core/src/` y regenerar el fixture de paridad** (ver
`core/README.md`). `tests/test_core_parity.py` y el workflow `check-core.yml` avisan si quedan
distintos.

### Overrides manuales

Si un canal no encuentra su EPG, agregalo a `xtream_channel_map.json`:

```json
{ "overrides": { "Nombre exacto del canal en Xtream": "channel_id-del-merged.xml.gz" } }
```

La clave es el nombre **crudo** tal como lo trae Xtream (antes de sacarle el prefijo, ver
arriba), que es lo que se copia del panel.

También se acepta `null` en vez de un `channel_id`, para forzar que un canal quede **sin EPG y
sin logo a propósito** — ni el matching automático ni el fallback de `epg_channel_id` de Xtream
lo van a tocar. Sirve para el caso de un canal cuya fuente resultó no confiable (ej. quedaba
matcheado a un `channel_id` con programación falsa tipo "Channel No Longer Available") y no hay
mejor alternativa: mejor sin EPG que con uno equivocado.

```json
{ "overrides": { "Nombre exacto del canal en Xtream": null } }
```

### Cuando un canal tiene varios EPG posibles

Muchos nombres (`"E!"`, `"TBS"`) existen varias veces en el EPG: un feed por país, o variantes
regionales de EE.UU. Se elige el de mayor puntaje (una sola entrada por canal en la playlist que arma el Worker)
y se incluyen hasta 4 alternativas en el `epg.xml.gz` de la configuración, **ordenadas por confianza**,
cada una con su `display-name` anotado al principio entre corchetes (`"[US East] TBS"`).

Va al principio y no al final para que la etiqueta no quede cortada si el reproductor trunca
los nombres largos. Para elegir otra, usá **"Seleccionar EPG"** en tu reproductor (TiviMate:
mantener presionado el canal → Editar → EPG) y, para que la elección quede fija, agregá el
override correspondiente.

## Orden y agrupación de categorías (`playlist_sections.json`)

- `order`: orden real de despliegue de las secciones. Mismo formato que `category_order` (ver
  más abajo): un objeto `{ "sección": número }`, menor número va primero — o una lista, donde
  la posición es el orden.

  ```json
  "order": { "ESPAÑOL": 10, "PAÍSES": 20, "ENGLISH": 30, "DEPORTES": 40 }
  ```
- `rules`: se evalúan de arriba hacia abajo (la primera que matchee gana). Tipos: `starts_with`,
  `equals` y `country_flag: true`. Los nombres se comparan sin emoji/acentos/mayúsculas.
- `epg` (opcional) declara contra qué fuentes conviene matchear esa sección:

```json
{ "section": "ENGLISH", "starts_with": ["usa"],
  "epg": { "country": "us", "prefer_sources": ["acidjesuz-us"] } }
```

- Las categorías "separador" del proveedor (`▆▆▆ＰＰＶ　ＥＶＥＮＴＳ▆▆▆`) se conservan como
  encabezado de su sección; las que no matchean ninguna regla van al final.
- `category_order` (opcional) fija el orden de las categorías dentro de la sección: un objeto
  `{ "nombre de categoría": número }`, menor número va primero.

  ```json
  { "section": "DEPORTES", "category_order": { "ESPN": 10, "FOX Sports": 20, "Deportes": 30 } }
  ```

  Los números van de a 10 para poder insertar una categoría nueva en el medio (ej. `15` entre
  `10` y `20`) cambiando un solo número, en vez de mover líneas en una lista. Se compara
  ignorando emoji, acentos y mayúsculas (igual que `starts_with`/`equals`), así que si el
  proveedor cambia el emoji de una categoría (`🏈 ESPN` → `⚽️ ESPN`) el orden se sigue
  respetando sin tener que editar nada. Una categoría nueva que matchee la sección pero no esté
  en el objeto se agrega al final, ordenada alfabéticamente junto a las demás categorías
  nuevas. Sin `category_order`, toda la sección se ordena alfabéticamente. El formato viejo
  (una lista, donde la posición es el orden) también se sigue aceptando.

## Perfiles de la corrida (opcional)

La corrida diaria **no necesita ninguna credencial de proveedor**: la programación y el catálogo de toda la guía salen
solo de `merged.xml.gz` (`planes/arquitectura-por-usuario.md`). Cada persona tiene su propia configuración en la web y
su lista, sus canales caídos y su vencimiento los resuelve el Worker por el relay.

Si hay un secret `XTREAM_PROFILES` (JSON), o las variables sueltas `XTREAM_USERNAME`, `XTREAM_PASSWORD` y
`XTREAM_SERVERS`, `generate_playlist.py` además cruza la guía con la lista de esas cuentas y deja su
`out/<perfil>/match_report.json`. Sirve solo como banco de pruebas del matcher (`match_benchmark.py --luis`,
`core_parity.py --luis`, `learn_preferences.py`, `source_coverage.py`). Sin esos secretos todo eso se saltea.

```json
{
  "servers": ["http://s1:8080", "http://s2:8080"],
  "profiles": [ { "name": "luis", "username": "u1", "password": "p1" } ]
}
```

Un perfil también puede ser una lista M3U (`"type": "m3u"` y la `url`). Los proveedores están en `providers.py`
(`XtreamProvider`, `M3UProvider`): todos devuelven la misma lista de canales (`name`, `category`, `url`, `icon`,
`epg_channel_id`), así sumar otro tipo de proveedor no toca el matching.

**Reglas propias del proveedor (`provider_rules.json`):** lo que depende de cómo arma su lista cada proveedor, fuera
del código. Sin este archivo el pipeline es genérico (sin separadores, categorías sin sección en el orden del proveedor,
nada excluido):

- `dividers`: `pattern` (regex) de las categorías decorativas que el proveedor usa como separador, `sections` (a qué
  sección corresponde cada una) y `display_names`.
- `category_order`: `provider` o `alphabetical`, para las categorías sin orden explícito.
- `event_sections`: secciones de eventos sueltos (PPV) que la interfaz no muestra para corregir, salvo
  `editable_categories`.
- `no_epg`: categorías, secciones y patrones que no necesitan guía (no cuentan en «A revisar» ni «Sin EPG»). Cada
  categoría también se puede marcar a mano desde la interfaz (Configuración → Categorías → **Sin guía**).

La interfaz lee el mismo archivo desde `main`, así un cambio de reglas se ve sin esperar al workflow.

## Cloudflare R2: configuración inicial

La corrida diaria sube a un bucket de R2 lo que Grilla web va a leer: el índice de la guía
para `@grilla/core` (`shared_guide.py` → `guide/index.json`) y la programación de la interfaz
(`ui/schedule/`: los canales en 256 tandas y los índices por hora en gzip, ver `tools/pack_schedule.py`,
unas 320 escrituras por día). Las fuentes de EPG no se nombran en nada de lo que sale del repo: en la guía y en
el XML de cada configuración van con un alias opaco (`source_alias.py`, `worker/src/crypto.ts`).
Es una regla genérica (`scrub_element` en `source_alias.py`), para cualquier fuente: las imágenes se
piden al Worker (logos de canal en `/logo/<clave>`, guardados en R2 la primera vez; imágenes de
programa en `/img/<clave>`, de paso), los `<url>` de canales y programas se sacan, y los links a
sitios de las fuentes (dominios de `epg_urls.json`) se borran de títulos y descripciones. El Worker
resuelve cada clave con los mapas privados `logo/map/` e `img/map/` de R2 (`shared_guide.py`,
`worker/src/logos.ts`). Los ids de canal salen con alias (`channel_alias` en `source_alias.py`, `core/src/alias.ts`; el matcher de la web resuelve el id de EPG de la lista con la clave `k` del id plegado), y una configuración guardada con el id real pasa al alias al abrirse en la web; la guía de cada configuración sale con el id que tiene guardado, que es el `tvg-id` de su playlist. El XML usa el Worker de `GRILLA_WORKER` (por defecto
`https://grilla.grilla.workers.dev`).
La subida la hace `tools/r2_upload.sh`. Si faltan los secretos, el paso no hace
nada; si falla, la corrida sigue igual. El bucket es **privado**: ver
`planes/licencias-fuentes-epg.md`.

Configuración, una sola vez:
1. Cloudflare → **R2 Object Storage** → activar R2. Pide una tarjeta aunque sea el plan gratis:
   hasta 10 GB no se cobra nada.
2. **Create bucket** → nombre `grilla`, ubicación automática. El acceso público queda
   desactivado.
3. R2 → **Manage R2 API Tokens** → **Create API token**. Permiso: *Object Read & Write*, solo
   para el bucket `grilla`. Guardar el *Access Key ID* y el *Secret Access Key*: el secreto se
   muestra una sola vez.
4. GitHub → repo → Settings → Secrets and variables → Actions → **New repository secret**:
   - `R2_ACCOUNT_ID`: el *Account ID* de Cloudflare (está en la página de R2, a la derecha);
   - `R2_ACCESS_KEY_ID` y `R2_SECRET_ACCESS_KEY`: los del paso 3.

   Si el bucket no se llama `grilla`, agregar además la *variable* `R2_BUCKET`.

Las claves van solo a los secretos del repo: no se pegan en el chat ni en ningún archivo.

## Workflows

| Workflow | Cuándo | Qué hace |
|---|---|---|
| `merge-epgs.yml` | a diario 17:30 UTC y a mano | la corrida diaria completa (ver `arquitectura.md`) |
| `refresh-lists.yml` | cada 3 horas y a pedido del Worker | arma la guía de las configuraciones nuevas o cambiadas |
| `discover-sources.yml` | lunes | actualiza `epg_sources_catalog.json` |
| `consumo.yml` | a diario 06:40 UTC | registra el uso de Worker, R2 y relay contra los planes gratis |
| `check-core.yml`, `check-worker.yml`, `version-check.yml` | en cada PR | tipos, tests y versión + CHANGELOG |
| `release.yml` | al llegar a `main` | crea la etiqueta y el release de la versión |
| `delete-config.yml`, `delete-short-links.yml` | a mano | borrados puntuales en R2 |
| `worker-smoke.yml` | a mano | prueba contra un Worker publicado; pide credenciales de un proveedor |

Con el repo privado en el plan Free hay ~2000 minutos de Actions por mes: la corrida diaria gasta unos 8–10 minutos y
`refresh-lists` uno o dos por corrida.
