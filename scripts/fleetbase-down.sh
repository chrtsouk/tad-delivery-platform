#!/usr/bin/env bash
# Stop Fleetbase. Pass --wipe to also delete OUR volumes (project "tadfb" only — never touches other Docker data).
cd "$(dirname "$0")/../docker/fleetbase"
if [ "${1:-}" = "--wipe" ]; then docker compose down -v --remove-orphans; rm -f .deployed; else docker compose down --remove-orphans; fi
docker image prune -f >/dev/null
