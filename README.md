# epg-merger

Fusiona varias fuentes EPG en una sola guía y, cruzándola con la lista real de canales de un
proveedor Xtream Codes, genera una playlist por persona con el `tvg-id` correcto en cada canal.

## Cómo está partido el trabajo

| Etapa | Qué produce | ¿Depende de quién sos? |
|---|---|---|
| `merge_epgs.py` | `merged.xml.gz` — las fuentes activas (59 de 83) fusionadas y deduplicadas | no |
| `generate_playlist.py` | `out/<perfil>/{playlist.m3u8, epg.xml.gz, match_report.json}` | solo en las credenciales |

La parte cara —fusionar las fuentes y decidir qué `tvg-id` le corresponde a cada canal— es
idéntica para todo el mundo y se hace **una sola vez**. Lo único que cambia entre personas son
el usuario y la contraseña que van dentro de la URL del stream.

`generate_playlist.py` lee `merged.xml.gz` en streaming (unos 1,3 GB de XML y 2 millones de
programas) en vez de cargarlo entero: una pasada por los canales para indexar y matchear todos
los perfiles, y otra por los programas, que van directo a la programación de la interfaz y a la
guía de cada perfil. Usa unos 600 MB de memoria en lugar de más de 10 GB, que en un runner
cargado hacían que la corrida se arrastrara por swap (de 8 a más de 30 minutos).

## Uso local

```bash
pip install -r requirements.txt
python merge_epgs.py
python generate_playlist.py
python -m pytest tests/ -q
```

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
`out/sources_report.json` (y en la branch `data`, para la interfaz):

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

Cada corrida deja un **`out/<perfil>/match_report.json`** con el candidato elegido, su puntaje,
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

### Interfaz: Grilla web (`worker/`)

**Grilla** (https://grilla.grilla.workers.dev) es la interfaz para corregir la playlist desde el
celular o la compu: un Cloudflare Worker con la app estática (`worker/web/`, compilada por
`worker/build.mjs`) y la API (`worker/src/`). Los cambios de canales, las listas y los links
viven en R2, no en este repo; el matching corre en el navegador con `@grilla/core` (`core/`).
Los datos de la guía (catálogo, reportes, programación) los sube la corrida diaria a R2.

Se puede instalar como PWA, avisa por push de canales nuevos y de eventos, y permite activar o
desactivar cada link sin borrarlo. La versión sale de `worker/package.json`; cada PR que toca
`worker/` o `core/` sube la versión y suma una sección a `CHANGELOG.md`, y `release.yml` crea la
etiqueta y el release solo.

Las ediciones por canal (EPG, nombre, categoría, ocultar, sin EPG) y por categoría se guardan
como `overrides`, `renames`, `categories`, `hidden`, `hidden_categories` y
`no_epg_categories`. Los canales de la sección de eventos y los de categorías "Sin guía" no
cuentan en "A revisar" ni en "Sin EPG".


### Cuando un canal tiene varios EPG posibles

Muchos nombres (`"E!"`, `"TBS"`) existen varias veces en el EPG: un feed por país, o variantes
regionales de EE.UU. Se elige el de mayor puntaje para la playlist (una sola entrada por canal)
y se incluyen hasta 4 alternativas en el `epg.xml.gz` del perfil, **ordenadas por confianza**,
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

## Varias personas con el mismo proveedor

Un único secret **`XTREAM_PROFILES`** con un JSON. Agregar a alguien es editar ese secret; el
workflow no se toca.

```json
{
  "servers": ["http://s1:8080", "http://s2:8080"],
  "profiles": [
    { "name": "luis", "username": "u1", "password": "p1" },
    { "name": "juan", "username": "u2", "password": "p2" }
  ]
}
```

`servers` es el balanceador del proveedor: una lista compartida por todos los perfiles, en
orden de preferencia (si el primero no responde, se prueba el siguiente). Un perfil puede traer
su propia lista `servers` si necesita servidores distintos a los del resto; en ese caso la
propia tiene prioridad sobre la compartida.

El formato viejo (una lista plana de perfiles, cada uno con su propio `servers`) sigue
funcionando. Si `XTREAM_PROFILES` no está, se usan las variables sueltas de siempre
(`XTREAM_USERNAME`, `XTREAM_PASSWORD`, `XTREAM_SERVERS`) como un perfil llamado `default`.

**Listas M3U (cualquier proveedor):** un perfil puede ser una lista M3U en vez de Xtream, con
`"type": "m3u"` y la `url` de la lista (o la ruta a un archivo). `group-title` es la categoría,
`tvg-logo` el logo y `tvg-id` una sugerencia de EPG que solo se acepta si el canal existe en la
guía y el nombre coincide (igual que el `epg_channel_id` de Xtream). Las URLs de stream se
conservan tal cual. La URL de la lista suele llevar credenciales, por eso va en el mismo secret.

```json
{ "profiles": [ { "name": "otra", "type": "m3u", "url": "https://proveedor/get.php?...&type=m3u_plus" } ] }
```

**Reglas propias del proveedor (`provider_rules.json`):** lo que depende de cómo arma su lista
cada proveedor, fuera del código. Sin este archivo el pipeline es genérico (sin separadores,
categorías sin sección en el orden del proveedor, nada excluido); el de este repo trae las del
proveedor actual:

- `dividers`: `pattern` (regex) de las categorías decorativas que el proveedor usa como separador
  (`▆▆▆ＤＥＰＯＲＴＥＳ▆▆▆`), `sections` (a qué sección corresponde cada una) y `display_names`.
- `category_order`: `provider` o `alphabetical`, para las categorías sin orden explícito.
- `event_sections`: secciones de eventos sueltos (PPV) que la interfaz no muestra para corregir,
  salvo `editable_categories`.
- `no_epg`: categorías, secciones y patrones que no necesitan guía (no cuentan en "A revisar"
  ni "Sin EPG"). Además, cada categoría se puede marcar a mano desde la interfaz
  (Configuración → Categorías → **Sin guía**), que se guarda en `xtream_channel_map.json` como
  `no_epg_categories`.

La interfaz lee el mismo archivo desde `main`, así un cambio de reglas se ve sin esperar al
workflow.

Los proveedores están en `providers.py` (`XtreamProvider`, `M3UProvider`): todos devuelven la
misma lista de canales (`name`, `category`, `url`, `icon`, `epg_channel_id`), así sumar otro tipo
de proveedor no toca el matching.

### Dónde termina cada archivo

| Artefacto | Destino | ¿Lleva credenciales? |
|---|---|---|
| `merged.xml.gz` | release `latest` | no |
| `epg_catalog.json` | release `latest` | no |
| guía, catálogo y programación de la interfaz | R2 (`guide/`, `ui/`) | no |
| `playlist.m3u8` | la entrega el Worker (`/p/<código>`) | sí, cifradas en el token |

Las playlists ya no se publican en gists: el Worker las arma al pedirlas y las credenciales
viajan solo dentro del token cifrado.


## Cloudflare R2 (Grilla web, Etapa 1)

La corrida diaria sube a un bucket de R2 lo que Grilla web va a leer: el índice de la guía
para `@grilla/core` (`shared_guide.py` → `guide/index.json`) y los datos de la interfaz
(`ui/`). La subida la hace `tools/r2_upload.sh`. Si faltan los secretos, el paso no hace
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

## Workflow

`.github/workflows/merge-epgs.yml` corre a diario a las 17:30 UTC (14:30 en Argentina) y también a mano
(`workflow_dispatch`). Los pasos son: tests → merge → playlists por perfil → reporte de uso de
fuentes → publicación de `merged.xml.gz` y `epg_catalog.json` al release → subida de la guía a R2
→ subida de los `match_report.json` como artifact.

`refresh-lists.yml` (cada 3 horas, y a pedido del Worker) baja la lista del proveedor desde
GitHub —para los proveedores que bloquean a Cloudflare— y arma la guía de cada configuración.
Descarga `merged.xml.gz` del release con el `GITHUB_TOKEN`, así funciona con el repo privado.

Con el repo privado en el plan Free hay ~2000 minutos de Actions por mes: la corrida diaria
gasta unos 8–10 minutos, por eso `refresh-lists` va cada 3 horas y no más seguido.
