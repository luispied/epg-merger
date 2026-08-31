# epg-merger

Fusiona varias fuentes EPG en una sola guía y, cruzándola con la lista real de canales de un
proveedor Xtream Codes, genera una playlist por persona con el `tvg-id` correcto en cada canal.

## Cómo está partido el trabajo

| Etapa | Qué produce | ¿Depende de quién sos? |
|---|---|---|
| `merge_epgs.py` | `merged.xml.gz` — las 75 fuentes fusionadas y deduplicadas | no |
| `generate_playlist.py` | `out/<perfil>/{playlist.m3u8, epg.xml.gz, match_report.json}` | solo en las credenciales |
| `publish_playlists.py` | publica cada playlist en su gist secreto | sí |

La parte cara —fusionar las fuentes y decidir qué `tvg-id` le corresponde a cada canal— es
idéntica para todo el mundo y se hace **una sola vez**. Lo único que cambia entre personas son
el usuario y la contraseña que van dentro de la URL del stream.

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
- Para deshabilitar una fuente sin borrarla, anteponé `#` a su `url`.

El formato viejo (`"urls": ["...", "..."]`) sigue funcionando: el `id` se deriva del nombre de
archivo y la prioridad es la posición.

### Deduplicación

Un canal presente en varias fuentes (los 7 archivos de España comparten decenas de
`channel_id`) tomaba antes la programación de **todas**, quedando repetida y solapada en la
guía. Ahora los programas se deduplican por `(canal, start)`: ante colisión gana la fuente más
prioritaria, y los horarios que ésa no cubre los siguen aportando las demás, así deduplicar no
cuesta días de guía.

## Cómo se matchea un canal con su EPG

Antes de tocar el nombre, se le saca el prefijo que el proveedor antepone y que no aporta nada
al verlo en el reproductor: código de país + `|` o `:` (`UY|`, `PT|`, `ES:`, `CL|`, `BR|`,
`AR|`, `USA|`, `E|`, `S|`, `D|`), número de evento (`EVENTS 01:`) o `24` + una letra (`24P`).
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

### Overrides manuales

Si un canal no encuentra su EPG, agregalo a `xtream_channel_map.json`:

```json
{ "overrides": { "Nombre exacto del canal en Xtream": "channel_id-del-merged.xml.gz" } }
```

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

### Dónde termina cada archivo

| Artefacto | Destino | ¿Lleva credenciales? |
|---|---|---|
| `merged.xml.gz` | release público `latest` | no |
| `epg-<perfil>.xml.gz` | release público `latest` | no |
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
(`workflow_dispatch`). Los pasos son: tests → merge → playlists por perfil → publicación de los
artefactos públicos al release → publicación de las playlists a los gists → subida de los
`match_report.json` como artifact.
