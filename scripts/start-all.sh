#!/usr/bin/env bash
# Start everything locally: Fleetbase, routing/address stack, then the platform (needs Docker running).
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/init-env.mjs
scripts/fleetbase-up.sh
docker compose -f docker/geo/docker-compose.yml up -d osrm vroom postcodes-db postcodes
if docker volume inspect tadgeo_photondata >/dev/null 2>&1 && docker run --rm -v tadgeo_photondata:/p alpine test -d /p/photon_data; then
  docker compose -f docker/geo/docker-compose.yml --profile photon up -d photon
fi
[ -d web/dist ] || npm run web:build
exec node server.js
