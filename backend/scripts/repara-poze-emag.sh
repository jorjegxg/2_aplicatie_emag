#!/usr/bin/env bash
# Repara pozele de pe eMAG RO/HU/BG (vezi repara-poze-emag.js).
#   ./backend/scripts/repara-poze-emag.sh             doar arata ce e stricat (nu trimite nimic)
#   ./backend/scripts/repara-poze-emag.sh --trimite   trimite pozele pentru ce a gasit
# Optiuni pentru scanare: --netrimise (si pozele schimbate in aplicatie), --cooldown <ore>, --produs <id>
# URL-urile pozelor se verifica de pe PC: containerul nu ajunge la adresa Tailscale.
set -euo pipefail

cd "$(dirname "$0")/../.."
DIR=backend/data/repara-poze
CONTAINER=emag-back
BAD=$(mktemp)
trap 'rm -f "$BAD"' EXIT

SEND=0
SCAN_ARGS=()
for a in "$@"; do
  if [[ "$a" == "--trimite" ]]; then SEND=1; else SCAN_ARGS+=("$a"); fi
done

docker exec "$CONTAINER" node scripts/repara-poze-emag.js scan "${SCAN_ARGS[@]}"

if [[ -s "$DIR/urls.txt" ]]; then
  echo "verific $(wc -l < "$DIR/urls.txt") URL-uri de poze de pe PC..."
  # 200 + image/* = bun; restul intra in lista de URL-uri rele
  xargs -P 8 -I{} sh -c '
    r=$(curl -sS -o /dev/null --max-time 25 -w "%{http_code} %{content_type}" "{}" 2>/dev/null || echo "000 -")
    case "$r" in "200 image/"*) ;; *) echo "{}" ;; esac
  ' < "$DIR/urls.txt" > "$BAD"
  bad=$(wc -l < "$BAD")
  total=$(wc -l < "$DIR/urls.txt")
  if [[ "$bad" -gt 0 ]]; then
    echo "ATENȚIE: $bad URL-uri nu răspund (produsele lor vor fi sărite):"
    sed 's/^/  /' "$BAD"
    if [[ "$bad" -eq "$total" ]]; then
      echo "Niciun URL nu merge — verifică Tailscale Funnel (:8443) și emag-front. Nu trimit nimic."
      exit 1
    fi
  fi
fi

if [[ "$SEND" -eq 1 ]]; then
  docker exec -i "$CONTAINER" node scripts/repara-poze-emag.js push --url-uri-rele - < "$BAD"
else
  echo "Nimic trimis. Rulează cu --trimite ca să pun pozele."
fi
