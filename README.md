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

### URLs finales

```text
https://github.com/luispied/epg-merger/releases/download/latest/playlist.m3u8
https://github.com/luispied/epg-merger/releases/download/latest/my_epg.xml.gz
```
