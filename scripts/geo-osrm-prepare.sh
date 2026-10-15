#!/usr/bin/env bash
# Build the OSRM graph into the tadgeo_osrmdata volume. Default = Greater London (130 MB, fine on a laptop).
# Production: PBF_URL=https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf (needs ~16 GB RAM for extract).
set -euo pipefail
PBF_URL="${PBF_URL:-https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf}"
IMG=ghcr.io/project-osrm/osrm-backend:v5.27.1
docker volume create tadgeo_osrmdata >/dev/null
if docker run --rm -v tadgeo_osrmdata:/data alpine test -f /data/region.osrm.mldgr; then echo "graph already built"; exit 0; fi
docker run --rm -v tadgeo_osrmdata:/data alpine sh -c "wget -q -O /data/region.osm.pbf '$PBF_URL'"
docker run --rm -v tadgeo_osrmdata:/data "$IMG" sh -c "set -e; cd /data; osrm-extract -p /opt/car.lua region.osm.pbf && osrm-partition region.osrm && osrm-customize region.osrm && rm -f region.osm.pbf"
echo "OSRM graph ready"
