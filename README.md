# epg-merger

Fusiona varias fuentes EPG en una sola guía y, cruzándola con la lista real de canales de un
proveedor Xtream Codes, genera una playlist por persona con el `tvg-id` correcto en cada canal.

## Cómo está partido el trabajo

| Etapa | Qué produce | ¿Depende de quién sos? |
|---|---|---|
| `merge_epgs.py` | `merged.xml.gz` — las fuentes activas (59 de 83) fusionadas y deduplicadas | no |
| `generate_playlist.py` | `out/<perfil>/{playlist.m3u8, epg.xml.gz, match_report.json}` | solo en las credenciales |
| `publish_playlists.py` | publica cada playlist en su gist secreto | sí |

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

### Interfaz de corrección (`docs/`)

**Grilla** (https://luispied.github.io/epg-merger/) es la interfaz para corregir la playlist
desde el celular o la compu. El engranaje de arriba abre **Configuración**: token de GitHub,
ayuda (también se abre sola la primera vez), tema (auto/claro/oscuro), mostrar logos, filtro
al abrir, **copia de seguridad** y "Restablecer la app" (borra preferencias y la caché de la app
en ese dispositivo; no toca los cambios de canales, que viven en GitHub, ni el token).

**Exportar configuración** baja un `grilla-configuracion-AAAA-MM-DD.json` con los cambios de
canales (`overrides`, `renames`, `categories`, `hidden`) y las preferencias del dispositivo; el
token no se incluye. **Importar configuración** acepta ese archivo (o un
`xtream_channel_map.json`), muestra un resumen, descarta entradas con forma inválida y, al
confirmar, reemplaza los cambios de canales con un commit (lo anterior queda en el historial de
git).

`docs/` (`index.html` + `app.css` + `app.js` + `icons.js`), servida por GitHub Pages, lista los canales con el EPG que se les asignó
(como todos los perfiles comparten canales y cambios, muestra siempre el primero) (`match_report-<perfil>.json`) — salvo los de la sección **PPV EVENTS**, que se
excluyen: son transmisiones puntuales que ningún EPG público cubre, así que nunca van a
matchear y no hay nada que corregir ahí. La excepción es la categoría **PPV DAZN**, que son
canales fijos (DAZN 1, 2, 3…) y sí se muestra — y deja elegir otro de las alternativas ya
calculadas o buscando en todo el EPG (`epg_catalog.json`: solo `channel_id`/nombre/país/fuente,
sin credenciales). Estos dos también se publican como asset del release `latest` (útil para
bajarlos con `gh`/`curl`), pero la interfaz los lee de una branch `data` aparte: los assets de
un release se sirven vía un redirect a Azure Blob que no manda cabecera CORS, así que el
navegador no puede leerlos con `fetch()`. La branch `data` se sobreescribe entera en cada
corrida (`git push -f`), no acumula historia — es contenido descartable, no algo para
versionar.

Al elegir un canal, la página commitea el override directo a `xtream_channel_map.json` en
`main` usando la API de GitHub desde el propio navegador. Hace falta un **fine-grained
personal access token** con permiso `Contents: Read and write` sobre este repo únicamente —
se pide la primera vez (⚙️ en la interfaz) y se guarda solo en `localStorage` del navegador,
nunca se manda a nada que no sea `api.github.com`. El cambio queda commiteado al toque, pero
solo se ve reflejado en la playlist después de la próxima corrida del workflow (diaria, o a
mano con `gh workflow run merge-epgs.yml`).

El buscador ("Buscar en todo el EPG") muestra al lado de cada resultado qué está dando ese
canal ahora mismo, y también busca por nombre de programa: si en el canal de Xtream se está
viendo "Friends", buscar `friends` lista los canales del EPG que lo están pasando en este
momento. Los que tienen programación en este horario van primero. Para eso `generate_playlist.py`
publica además, en `schedule/hour/<AAAAMMDDHH>.json` de la branch `data`, un índice por hora UTC
con lo que da todo el catálogo; la página baja solo el de la hora actual (~0,5 MB comprimido).

Desde cada tarjeta también se puede:

- **Renombrar el canal** (menú **…** de la tarjeta → Cambiar nombre): guarda `"renames": {"nombre en Xtream":
  "nombre a mostrar"}`. Solo cambia el nombre que se ve en la playlist; el matching y los
  overrides de EPG siguen yendo por el nombre original de Xtream.
- **Moverlo de categoría** (menú **…** → Mover de categoría): guarda `"categories": {"nombre en
  Xtream": "categoría destino"}`. Cambia en qué grupo/sección aparece en la playlist; el EPG se
  sigue eligiendo con la categoría original, para que moverlo no le cambie el EPG sin avisar.
- **Ocultarlo** (menú **…** → switch *Visible en la playlist*; la tarjeta queda atenuada con la marca *Oculto*): guarda `"hidden": {"nombre en Xtream": true}`. El
  canal (o separador) sale de la playlist y su EPG de la guía del perfil, pero sigue en el
  reporte, así que aparece en la pestaña **Ocultos** para volver a mostrarlo. Los ocultos no
  cuentan en "A revisar" ni en "Sin EPG".
- **Cambios masivos** (botón de selección del encabezado, o mantener apretada una tarjeta):
  se marcan varios canales (o **Todos** los del filtro y la búsqueda actuales) y el botón **…**
  aplica a todos juntos: el mismo EPG (con sugerencias de las opciones que más se repiten entre
  los elegidos), mover de categoría, ocultar/mostrar, volver al EPG automático, restaurar
  nombres o categorías originales y dejar sin EPG. Es un solo commit y un solo *Deshacer*.
- **Ocultar una categoría entera** (Configuración → Categorías, un switch por categoría):
  guarda `"hidden_categories": {"categoría en Xtream": true}`. Todos sus canales salen de la
  playlist y de la guía como si estuvieran ocultos uno por uno; cuenta la categoría donde se
  muestra el canal, así que uno movido desde ahí a una categoría visible sigue saliendo. En la
  interfaz esos canales solo aparecen en **Ocultos**.

Todo se aplica en la próxima corrida del workflow, que se puede lanzar desde la misma página
con el botón de **play** (muestra el estado hasta que termina, y cuando hay cambios guardados desde la
última corrida dice **"Aplicar N"**). Si ya hay una corrida en marcha, la nueva queda en cola y
arranca cuando esa termina: el workflow corre de a una y en orden (`concurrency` en
`merge-epgs.yml`), así la última en publicar es siempre la más nueva. El botón de **actualizar** vuelve a bajar
catálogo, reportes y programación sin recargar la página (por ejemplo, después de que termina
el workflow); la barra de estado muestra de cuándo son los datos y avisa cuando la programación
publicada (que cubre ~30 h desde la última corrida) ya venció. Para eso el token necesita
además el permiso `Actions: Read and write`.

Cada cambio se guarda al instante y muestra abajo un aviso con **Deshacer** por unos segundos;
también hay avisos al lanzar el workflow, cuando termina (o falla), al actualizar datos y al
guardar el token. Todas las acciones de un canal (EPG, nombre, categoría, visibilidad y volver
al EPG automático) están en el menú **…** de su tarjeta. Los íconos son SVG de [Lucide](https://lucide.dev) (licencia ISC) embebidos en
`docs/icons.js`, sin depender de ninguna librería externa.

Cada tarjeta, alternativa y resultado de búsqueda muestra el **logo** del canal del EPG
(`epg_icons.json` en la branch `data`: `{channel_id: url}`, solo los que traen `<icon>`, con las
URLs `http://` pasadas a `https://`). La interfaz lo baja en segundo plano después de mostrar la
lista; si un logo no carga queda un ícono genérico.

La página es una **PWA**: en el celular se puede agregar a la pantalla de inicio ("Agregar a
inicio" en Safari, "Instalar app" en Chrome) y abre a pantalla completa, sin la barra del
navegador. `docs/sw.js` guarda solo la interfaz (network-first: siempre busca primero la versión
publicada y usa la guardada únicamente sin conexión); los datos siempre vienen de la red. En
iPhone la app instalada tiene su propio almacenamiento, así que la primera vez hay que volver a
pegar el token.

`docs/app.js` es JavaScript sin compilar, pero con tipos en comentarios (JSDoc + `// @ts-check`,
tipos de los datos en `docs/types.d.ts`). El workflow **Check UI** corre `tsc -p docs` en cada PR
que toca `docs/`; localmente: `npx -p typescript@5.9 tsc -p docs`.

Renombrar, mover de categoría y volver al EPG automático están en el menú **…** de cada
tarjeta; las pestañas de filtro muestran cuántos canales hay en cada una (con la búsqueda
aplicada, si hay texto), y **Editados** junta
los renombrados, movidos y ocultos. La categoría **General** (donde caen los canales sin
categoría en Xtream, sobre todo eventos sueltos) y la sección **24/7** (series y películas en
loop, cualquier categoría "24 7 …") no aparecen en "A revisar" ni en "Sin EPG", pero sí en
"Todos".

El botón **"Dejar sin EPG"** del editor guarda un override en `null` en vez de elegir un
canal (ver arriba): sirve para los casos donde ninguna alternativa es confiable y es mejor
dejarlo sin EPG a propósito que con uno incorrecto.

Al abrir el editor de un canal, cada alternativa (y el EPG ya asignado) muestra qué programa
está dando **en ese momento**: `generate_playlist.py` publica, por canal, su programación de
`out/schedule/<hash>.json` (ventana de -1h a +30h desde la corrida, sin credenciales, también
en la branch `data`) y la página calcula "ahora" comparando contra el reloj del navegador —
sigue siendo preciso aunque se mire horas después de la corrida, no es una foto congelada al
momento de generarla. Se pide bajo demanda (al abrir el editor, o con el botón 📺 de un
resultado de búsqueda), no de entrada para los ~21.000 canales del catálogo.

Tocando la línea **Ahora: …** se despliega la descripción del programa (la sinopsis de la guía
o, si no trae, el nombre del episodio). Va como cuarto elemento de cada entrada de ese mismo
archivo por canal (recortada a 400 caracteres) y se baja recién al tocarla: el índice por hora,
que se baja entero, no la lleva.

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
    { "name": "luis", "username": "u1", "password": "p1", "gist_id": "abc123" },
    { "name": "juan", "username": "u2", "password": "p2", "gist_id": "def456" }
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
{ "profiles": [ { "name": "otra", "type": "m3u", "url": "https://proveedor/get.php?...&type=m3u_plus", "gist_id": "…" } ] }
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
| `merged.xml.gz` | release público `latest` | no |
| `epg-<perfil>.xml.gz` | release público `latest` | no |
| `epg_catalog.json` | release público `latest` | no |
| `match_report-<perfil>.json` | release público `latest` | no |
| `playlist.m3u8` | **gist secreto** propio de cada persona | **sí** |

La playlist lleva usuario y contraseña dentro de **cada URL de stream**, así que no puede ir a
un release público. Va a un gist secreto por persona — el archivo dentro del gist siempre se
llama `playlist.m3u8` (lo que distingue a cada perfil es el gist en sí, no el nombre del
archivo) —, cuya URL raw no pide autenticación y funciona directo en TiviMate:

```text
https://gist.githubusercontent.com/<usuario>/<gist_id>/raw/playlist.m3u8
```

> **Modelo de amenaza**: "secreto" en un gist significa *inadivinable*, no privado — quien
> tenga la URL ve el contenido. Es el mismo modelo que las credenciales viviendo dentro de la
> URL del stream, y una mejora grande frente a un asset de release público e indexable, pero
> no es cifrado.

Hace falta un secret **`GIST_TOKEN`**: un PAT con scope `gist`. El `GITHUB_TOKEN` del workflow
no sirve, no tiene permiso sobre gists. Sin ese secret, las playlists quedan solo en `out/`.

### EPG compartido

Quien no use este flujo puede consumir directamente la guía completa:

```text
https://github.com/luispied/epg-merger/releases/download/latest/merged.xml.gz
```

`merged.xml.gz` pesa ~134 MB, por encima del límite de 100 MB por archivo que impone git en un
commit normal, así que **no se commitea**: cada corrida lo sube como asset del release `latest`
reemplazando la versión anterior (`--clobber`). Así se evitan tanto el límite de tamaño como
las cuotas de ancho de banda de Git LFS.

## Workflow

`.github/workflows/merge-epgs.yml` corre a diario a las 16:00 UTC y también a mano
(`workflow_dispatch`). Los pasos son: tests → merge → playlists por perfil → reporte de uso de
fuentes → publicación de los
artefactos públicos al release → publicación de las playlists a los gists → subida de los
`match_report.json` como artifact.
