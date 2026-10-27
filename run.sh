#!/usr/bin/env bash
# Rebuild GraphHopper (bundle maps local + backend) et relance le serveur.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "==> Build du bundle maps (graphhopper-maps)..."
if [ -d "graphhopper-maps" ]; then
  (cd graphhopper-maps && npm run build --silent && npm pack)
else
  echo "Erreur: répertoire graphhopper-maps manquant. Clonez-le pour la couche trafic."
  exit 1
fi

echo "==> Build Maven (profil local-maps)..."
cd graphhopper-traffic
mvn package -DskipTests -Plocal-maps -Dmaven.repo.local="$ROOT/.m2/repository" -q

echo "==> Arrêt d'un éventuel serveur déjà en cours..."
pkill -f "graphhopper-web-11.0-SNAPSHOT.jar" 2>/dev/null || true
sleep 2

echo "==> Démarrage du serveur GraphHopper..."
exec java -Ddw.graphhopper.datareader.file=genevois.osm.pbf \
  -jar web/target/graphhopper-web-11.0-SNAPSHOT.jar server config-example.yml
