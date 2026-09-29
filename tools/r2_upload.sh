#!/usr/bin/env bash
# Sube a Cloudflare R2 lo que Grilla web (Etapa 1) lee de la corrida diaria. Usa la API
# compatible con S3 de R2 (el `aws` que ya viene en los runners de GitHub).
#
# Variables (secretos del repo): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y,
# opcional, R2_BUCKET (por defecto "grilla"). Sin credenciales no hace nada.
#
# Estructura en el bucket:
#   guide/index.json           canales + fuentes + reglas, para @grilla/core (shared_guide.py)
#   ui/epg_catalog.json        catálogo para la interfaz
#   ui/epg_icons.json          logos
#   ui/sources_report.json     uso de fuentes y sugerencias
#   ui/schedule/…              programación por canal y por hora
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

json=(--content-type application/json)
s3 cp out/shared/guide/index.json "$BUCKET/guide/index.json" "${json[@]}"
for f in epg_catalog.json epg_icons.json sources_report.json; do
  [ -f "out/$f" ] && s3 cp "out/$f" "$BUCKET/ui/$f" "${json[@]}"
done
# --delete: los canales que ya no tienen programación dejan de estar.
[ -d out/schedule ] && s3 sync out/schedule "$BUCKET/ui/schedule" --delete "${json[@]}"
echo "✅ Subido a R2 ($BUCKET)"

# Guía de cada configuración: se bajan las configuraciones (sin credenciales), se arman todas
# en una pasada por la guía y se suben. --delete: la de una configuración borrada deja de estar.
rm -rf out/cfgs out/cfg_epg
s3 sync "$BUCKET/cfg" out/cfgs --exclude '*' --include '*.json'
python tools/config_epgs.py --configs out/cfgs --out out/cfg_epg
if [ -d out/cfg_epg ]; then
  s3 sync out/cfg_epg "$BUCKET/epg" --delete --content-type application/gzip
  echo "✅ Guías de Grilla web subidas"
fi
