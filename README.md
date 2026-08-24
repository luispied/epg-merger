# epg-merger

Script y workflow para descargar varios archivos EPG, fusionarlos y publicar `merged.xml.gz` en el repositorio para servirlo con GitHub Pages.

## Uso local

```bash
pip install -r requirements.txt
python merge_epgs.py
```

Edita `/home/runner/work/epg-merger/epg-merger/epg_urls.json` y añade o ajusta tus URLs.

## GitHub Actions

El workflow `.github/workflows/merge-epgs.yml` permite ejecutar el merge de forma manual (`workflow_dispatch`) y diaria a las `02:00 UTC`.

## GitHub Pages

Habilita GitHub Pages desde **Settings → Pages** usando la rama principal para servir el archivo generado:

```text
https://tu-usuario.github.io/epg-merger/merged.xml.gz
```
