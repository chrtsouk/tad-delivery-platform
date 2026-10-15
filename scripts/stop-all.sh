#!/usr/bin/env bash
# Stop everything and free Docker resources WE created (only our compose projects: tadfb, tadgeo). Pass --wipe to delete their data volumes too.
cd "$(dirname "$0")/.."
WIPE="${1:-}"
docker compose -f docker/geo/docker-compose.yml --profile photon down --remove-orphans ${WIPE:+-v}
scripts/fleetbase-down.sh ${WIPE}
docker image prune -f >/dev/null
