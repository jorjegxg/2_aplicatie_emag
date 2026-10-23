#!/usr/bin/env bash
# Pregătește pe i3 toate pozele produselor într-un folder obișnuit, ca laptopul
# să le poată lua cu scp: <EXPORT_DIR>/<cod_produs>/<en|ro|hu|bg>/01.jpg ...
# Pornit de pe laptop prin ssh (vezi scripts/descarca-poze-laptop.ps1).
set -euo pipefail

CONTAINER="${BACK_CONTAINER:-emag-back}"
EXPORT_DIR="${1:-$HOME/emag-poze-export}"
TMP_IN_CONTAINER=/tmp/poze-export
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Scriptul Node e copiat la fiecare rulare: merge și fără rebuild la imaginea back.
docker cp "$SCRIPT_DIR/export-product-images.js" "$CONTAINER:/app/scripts/export-product-images.js" >/dev/null
docker exec "$CONTAINER" rm -rf "$TMP_IN_CONTAINER"
docker exec "$CONTAINER" node scripts/export-product-images.js "$TMP_IN_CONTAINER"

# Export curat de fiecare dată, ca pozele șterse din aplicație să nu rămână în folder.
rm -rf "$EXPORT_DIR"
docker cp "$CONTAINER:$TMP_IN_CONTAINER" "$EXPORT_DIR" >/dev/null
docker exec "$CONTAINER" rm -rf "$TMP_IN_CONTAINER"
echo "Gata: $EXPORT_DIR"
