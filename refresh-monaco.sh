#!/usr/bin/env bash
# Rafraîchit le trafic TomTom de la Côte d'Azur sur GraphHopper.
# Zoom 14 (couverture identique à z16 : tuiles vectorielles, toutes catégories),
# whitelist de tuiles routières (~464 requêtes/run au lieu de 13 530 à z16),
# régénérée par un sweep complet quand elle est absente ou plus vieille que
# WHITELIST_MAX_AGE_HOURS (nouvelles routes / fermetures).
# Les vitesses restent en mémoire : à relancer après un redémarrage de GraphHopper.
#
# Historique : arrêté le 2026-09-30 (z16 bbox pleine ~13k tuiles / 5 min, trop cher).
# Relancé avec z14 + whitelist (~97% de requêtes en moins).
# Cron : */5 6-21 * * * /home/epascal/Projects/chtrafic/refresh-monaco.sh
# Runs 06:00-21:59 local uniquement : ~192 runs/jour ≈ 95k requêtes réparties sur
# 2 clés (~47,6k/clé) → sous le quota gratuit TomTom de 50k tuiles/jour/clé.
# Le trafic nocturne est quasi freeflow, la précision 5 min compte en journée.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-$ROOT/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/refresh-monaco.log}"
LOCK_FILE="${LOCK_FILE:-$LOG_DIR/refresh-monaco.lock}"
mkdir -p "$LOG_DIR"

# Théoule / Grasse → Menton, et l'arrière-pays jusqu'à Lucéram / Sospel.
# Couvre la carte aéroport → musée (A8, corniches, voies intérieures).
# lonMin,latMin,lonMax,latMax
BBOX="${BBOX:-6.88,43.48,7.55,43.91}"
ZOOM="${ZOOM:-14}"
URL="${GRAPHHOPPER_URL:-http://graphhopper.flowride.org:8989}"

# Whitelist des tuiles routières au zoom courant (mer/montagne ignorées).
TILE_LIST="${TILE_LIST:-$ROOT/tomtom/tiles-z${ZOOM}.json}"
# Âge max de la whitelist avant re-scan complet (nouvelles routes, fermetures).
WHITELIST_MAX_AGE_HOURS="${WHITELIST_MAX_AGE_HOURS:-24}"

# Cron n'a pas le PATH nvm : charge Node avant npx.
if ! command -v npx >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  [[ -f "$HOME/.nvm/nvm.sh" ]] && . "$HOME/.nvm/nvm.sh"
fi
command -v npx >/dev/null 2>&1 || {
  echo "[$(date -Is)] ECHEC: npx introuvable" >&2
  exit 1
}

# Charge .env (clés TomTom) sans exporter le contenu dans les logs.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

# Alternance toutes les 5 minutes : 0→clé1, 5→clé2, 10→clé1, …
minute="$(date +%-M)"
key_slot=$(( (minute / 5) % 2 + 1 ))
key_var="TOMTOM_API_KEY_${key_slot}"
selected_key="${!key_var:-}"
if [[ -z "$selected_key" ]]; then
  selected_key="${TOMTOM_API_KEY:-}"
  key_slot="legacy"
fi
if [[ -z "$selected_key" ]]; then
  echo "[$(date -Is)] ECHEC: aucune clé TomTom (TOMTOM_API_KEY_1 / _2 ou TOMTOM_API_KEY)" >&2
  exit 1
fi
export TOMTOM_API_KEY="$selected_key"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date -Is)] skip: un rafraîchissement Monaco est déjà en cours" | tee -a "$LOG_FILE"
  exit 0
fi

# Whitelist fraîche → fetch restreint ; absente/expirée → sweep complet qui la régénère.
fetch_args=(--fetch --fetch-zoom "$ZOOM" --bbox "$BBOX" --url "$URL")
max_age_secs=$(( WHITELIST_MAX_AGE_HOURS * 3600 ))
if [[ -f "$TILE_LIST" ]] && (( $(date +%s) - $(stat -c %Y "$TILE_LIST") < max_age_secs )); then
  fetch_args+=(--fetch-tile-list "$TILE_LIST")
  fetch_mode="whitelist"
else
  fetch_args+=(--fetch-save-tile-list "$TILE_LIST")
  fetch_mode="sweep-complet (regen whitelist)"
fi

{
  echo "[$(date -Is)] start bbox=$BBOX zoom=$ZOOM url=$URL key_slot=$key_slot mode=$fetch_mode"
  npx tsx src/push-graphhopper.ts "${fetch_args[@]}"
  echo "[$(date -Is)] ok key_slot=$key_slot"
} >>"$LOG_FILE" 2>&1
