#!/usr/bin/env bash
# Photon with a GB-only extract. Downloads the jar and the GB index ONCE into the tadgeo_photondata volume, deletes the archive after extracting.
# Disk: ~3.5 GB download + ~8 GB index. Then:  docker compose -f docker/geo/docker-compose.yml --profile photon up -d photon
set -euo pipefail
PHOTON_VERSION="${PHOTON_VERSION:-0.7.4}"           # pinned: must match the index format
INDEX_URL="${INDEX_URL:-https://download1.graphhopper.com/public/extracts/by-country-code/gb/photon-db-gb-250720.tar.bz2}"
docker volume create tadgeo_photondata >/dev/null
docker run --rm -v tadgeo_photondata:/photon eclipse-temurin:21-jre sh -c "set -e; cd /photon; [ -d photon_data ] && echo 'index already present' && exit 0; \
  apt-get update >/dev/null && apt-get install -y wget bzip2 >/dev/null; \
  wget -q -O photon.jar https://github.com/komoot/photon/releases/download/${PHOTON_VERSION}/photon-${PHOTON_VERSION}.jar; \
  wget -q -O index.tar.bz2 '$INDEX_URL' && tar -xjf index.tar.bz2 && rm -f index.tar.bz2"
echo "Photon ready"
