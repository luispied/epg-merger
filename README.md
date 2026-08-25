# epg-merger

Script y workflow para descargar varios archivos EPG, fusionarlos y publicar `merged.xml.gz` como asset de un GitHub Release.

## Uso local

```bash
pip install -r requirements.txt
python merge_epgs.py
```

Edita `epg_urls.json` y añade el resto de tus URLs en `urls`.

## GitHub Actions

El workflow `.github/workflows/merge-epgs.yml` permite ejecutar el merge de forma manual (`workflow_dispatch`) y diaria a las `02:00 UTC`.

`merged.xml.gz` (~140 MB) ya supera el límite de 100 MB por archivo que impone git en un commit normal, así que **no se commitea al repositorio**: cada corrida lo sube como asset del release `latest`, reemplazando la versión anterior (`gh release upload --clobber`). Así se evita tanto el límite de tamaño como las cuotas de ancho de banda de Git LFS.

## Consumir el EPG generado

Usa esta URL fija en tu reproductor (TiviMate, etc.) — siempre apunta a la última versión generada:

```text
https://github.com/luispied/epg-merger/releases/download/latest/merged.xml.gz
```

## Integración con tu proveedor Xtream Codes (opcional)

Si tu proveedor IPTV usa la API Xtream Codes, el workflow puede cruzar **tu lista real de canales contratados** con el EPG generado, produciendo:

- `playlist.m3u8`: lista de canales lista para TiviMate, con `tvg-id` apuntando al EPG correcto.
- `my_epg.xml.gz`: subconjunto de `merged.xml.gz` acotado solo a tus canales (mucho más liviano que el EPG completo).

### Configurar credenciales (Secrets, no en el repo)

El repo es público, así que las credenciales **nunca** van en un archivo versionado. Configúralas en **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Ejemplo |
|---|---|
| `XTREAM_USERNAME` | `mi_usuario` |
| `XTREAM_PASSWORD` | `mi_contraseña` |
| `XTREAM_SERVERS` | `http://servidor1.com:8080,http://servidor2.com:8080,http://servidor3.com:8080` |

`XTREAM_SERVERS` acepta hasta 3 (o más) servidores separados por coma, en orden de preferencia. Si el primero no responde, el script prueba automáticamente el siguiente (failover). Si estos 3 Secrets no están configurados, el workflow simplemente omite este paso y sigue generando `merged.xml.gz` como siempre.

### Uso local

```bash
export XTREAM_USERNAME=mi_usuario
export XTREAM_PASSWORD=mi_contraseña
export XTREAM_SERVERS="http://servidor1.com:8080,http://servidor2.com:8080"
python merge_epgs.py       # genera merged.xml.gz primero
python generate_playlist.py
```

### Canales sin match automático

El matching es por nombre normalizado (sin acentos/mayúsculas/sufijos como HD, 4K, etc.). Si algún canal de tu lista no encuentra EPG automáticamente, el script lo lista al final de la corrida — agrégalo a `xtream_channel_map.json`:

```json
{
  "overrides": {
    "Nombre exacto del canal en Xtream": "channel_id-del-merged.xml.gz"
  }
}
```

### Cuando un canal tiene varios EPG posibles

Muchos nombres de canal (ej. "E!", "TBS") existen varias veces en el EPG mergeado — un feed distinto por país, o variantes regionales de EE.UU. (East/West/Pacific). El script elige uno automáticamente para `playlist.m3u8` (una sola entrada por canal, sin duplicados), pero **también incluye hasta 4 alternativas en `my_epg.xml.gz`**, cada una con su `display-name` anotado **al principio** entre corchetes — país + feed regional si se detectaron (ej. `"[US East] TBS"` vs `"[US Pacific] TBS"`), o si no, el propio `channel_id` (y si dos alternativas quedarían con la misma etiqueta, ej. dos ".us" sin feed detectado, se les agrega un fragmento del `channel_id` para poder distinguirlas). Va al principio y no al final para que la etiqueta no quede cortada si el reproductor trunca nombres largos por el lado derecho.

Si la elección automática no es la correcta, usá la función **"Seleccionar EPG"** de tu reproductor (en TiviMate: mantener presionado el canal → Editar → EPG) — busca sobre toda la guía cargada, así que vas a poder encontrar las alternativas anotadas por su nombre y elegir la que sí tenga la programación correcta. Para que la elección quede fija en la próxima corrida (en vez de tener que repetirlo cada vez), agregá un override en `xtream_channel_map.json` con el `channel_id` de la alternativa correcta.

### Orden y agrupación de categorías

`playlist_sections.json` agrupa las ~99 categorías de Xtream en secciones ("paraguas") y define en qué orden aparecen en `playlist.m3u8`. Es editable sin tocar Python:

- `order`: orden real de despliegue de las secciones.
- `rules`: se evalúan de arriba hacia abajo (la primera que matchee una categoría gana) — no tiene que coincidir con `order`. Tipos: `starts_with` (prefijos), `equals` (nombres exactos) y `country_flag: true` (cualquier categoría con emoji de bandera de país). Los nombres de categoría se comparan sin emoji/acentos/mayúsculas (`"🏈 ESPN"` → `"espn"`).
- Las categorías "separador" decorativas del proveedor (ej. `▆▆▆ＰＰＶ　ＥＶＥＮＴＳ▆▆▆`) se conservan como encabezado al principio de su sección.
- Las categorías que no matchean ninguna regla van al final, en su orden original.

### URLs finales

```text
https://github.com/luispied/epg-merger/releases/download/latest/playlist.m3u8
https://github.com/luispied/epg-merger/releases/download/latest/my_epg.xml.gz
```
