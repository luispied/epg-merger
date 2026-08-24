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
https://github.com/tu-usuario/epg-merger/releases/download/latest/merged.xml.gz
```
