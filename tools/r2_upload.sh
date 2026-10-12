#!/usr/bin/env bash
# Sube a Cloudflare R2 lo que Grilla web (Etapa 1) lee de la corrida diaria. Usa la API
# compatible con S3 de R2 (el `aws` que ya viene en los runners de GitHub).
#
# Variables (secretos del repo): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y,
# opcional, R2_BUCKET (por defecto "grilla"). Sin credenciales no hace nada.
#
# Estructura en el bucket:
#   guide/index.json           canales + fuentes + reglas, para @grilla/core (shared_guide.py)
#   ui/schedule/s/<xx>         programación por canal, en 256 tandas (tools/pack_schedule.py)
#   ui/schedule/hour/…         programación de toda la guía por hora, en gzip
#   ui/schedule/cfg/<cfgId>    la de cada hora con solo los canales de esa configuración
#   logo/map/<x>.json         {clave: url} de los logos de canal, en gzip como el índice y img/map (privado; el Worker los sirve por /logo/<clave>
#                              y guarda cada uno en logo/img/<clave> la primera vez)
#   img/map/<xx>.json          lo mismo para las imágenes de programa (/img/<clave>, sin guardarlas)
#
# El catálogo, los logos y el uso de fuentes (epg_catalog.json, epg_icons.json,
# sources_report.json) ya no se suben: la web no los usa y nombran las fuentes. Quedan en el
# artifact de la corrida.
#   epg/<cfgId>.xml.gz         guía de cada configuración de Grilla web (tools/config_epgs.py,
#                              a partir de las configuraciones cfg/<cfgId>.json que guarda el Worker)
set -euo pipefail

if [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] || [ -z "${R2_ACCOUNT_ID:-}" ]; then
  echo "ℹ️  Sin credenciales de R2 (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY): no se sube nada."
  exit 0
fi

BUCKET="s3://${R2_BUCKET:-grilla}"
export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
# R2 no acepta todos los checksums que las versiones nuevas del aws cli mandan por defecto.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
aws configure set default.s3.max_concurrent_requests 32
s3() { aws s3 --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" --only-show-errors "$@"; }

# tools/r2_sync.py sube solo lo que cambió (compara el MD5 con el ETag de R2): cada subida es una
# escritura de clase A. --gzip: se guarda comprimido y el Worker lo lee o lo entrega así.
sync() { python tools/r2_sync.py "$@"; }
json=(--type application/json)
sync out/shared/guide/index.json guide/index.json "${json[@]}" --gzip
# Privados (el Worker no los sirve): con esto resuelve /logo/<clave> e /img/<clave> (source_alias.py).
for kind in logo img; do
  [ -d "out/shared/$kind/map" ] && sync "out/shared/$kind/map" "$kind/map" --delete "${json[@]}" --gzip
done
# Las copias viejas de lo que ya no se publica.
for f in epg_catalog.json epg_icons.json sources_report.json; do s3 rm "$BUCKET/ui/$f"; done
# Programación empacada (tools/pack_schedule.py): 256 tandas con los canales y los índices por hora
# en gzip, unas 320 escrituras por día en vez de un archivo por canal (~17.500). --delete: la hora
# que ya pasó deja de estar.
# Los géneros que la IA ya clasificó (ai/genres.json, tools/classify_genres.py) van en cada programa de esos
# canales; los de hoy entran mañana (la clasificación corre al final de la corrida). Sin el archivo, sin géneros.
genres=()
rm -f out/genres.json
if s3 cp "$BUCKET/ai/genres.json" out/genres.json 2>/dev/null; then genres=(--genres out/genres.json); fi
python tools/pack_schedule.py "${genres[@]}" out/schedule out/schedule_r2
if [ -d out/schedule_r2/s ]; then
  sync out/schedule_r2/s ui/schedule/s
  [ -d out/schedule_r2/hour ] && sync out/schedule_r2/hour ui/schedule/hour --delete "${json[@]}" --encoding gzip
  # Los archivos por canal de antes del empaque (ui/schedule/<archivo>.json), que ya no se usan.
  # Solo los .json sueltos de ui/schedule/: ni las tandas ni las horas ni nada fuera de ui/schedule/.
  s3 rm "$BUCKET/ui/schedule/" --recursive --exclude '*' --include '*.json' --exclude 's/*' --exclude 'hour/*'
fi
echo "✅ Subido a R2 ($BUCKET)"

# Guía de cada configuración: se bajan las configuraciones (sin credenciales), se arman todas
# en una pasada por la guía y se suben. --delete: la de una configuración borrada deja de estar.
rm -rf out/cfgs out/cfg_epg
s3 sync "$BUCKET/cfg" out/cfgs --exclude '*' --include '*.json'
python tools/config_epgs.py --configs out/cfgs --out out/cfg_epg
# El índice por hora de cada configuración (solo sus canales), lo que baja la Guía en el celular.
python tools/pack_schedule.py --configs out/cfgs out/schedule out/schedule_cfg
[ -d out/schedule_cfg ] && sync out/schedule_cfg ui/schedule/cfg --delete
if [ -d out/cfg_epg ]; then
  sync out/cfg_epg epg --delete --type application/gzip
  echo "✅ Guías de Grilla web subidas"
fi
