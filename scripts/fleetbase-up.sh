#!/usr/bin/env bash
# Start Fleetbase (unmodified upstream images) locally. Secrets are generated once into docker/fleetbase/.env (gitignored).
set -euo pipefail
cd "$(dirname "$0")/../docker/fleetbase"
if [ ! -f .env ]; then
  umask 077
  printf 'APP_KEY=base64:%s\nDB_ROOT_PASSWORD=%s\n' "$(openssl rand -base64 32 | tr -d '\n')" "$(openssl rand -hex 16)" > .env
fi
[ -f api.env ] || echo "# Fleetbase API env overrides (runtime config comes from docker-compose.yml)" > api.env
[ -f console.config.json ] || printf '{\n  "API_HOST": "http://localhost:8000",\n  "SOCKETCLUSTER_HOST": "localhost",\n  "SOCKETCLUSTER_PORT": "38000",\n  "SOCKETCLUSTER_SECURE": "false"\n}\n' > console.config.json
docker compose up -d database cache socket
echo "waiting for database..."; until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q database)")" = healthy ]; do sleep 3; done
docker compose up -d application queue scheduler console
echo "waiting for application..."; for i in $(seq 1 60); do docker compose exec -T application true 2>/dev/null && break; sleep 3; done
if ! docker compose exec -T application php artisan migrate:status >/dev/null 2>&1 || [ ! -f .deployed ]; then
  docker compose exec -T database mysql -uroot -p"$(grep DB_ROOT_PASSWORD .env | cut -d= -f2)" -e "GRANT ALL PRIVILEGES ON *.* TO 'root'@'%'; FLUSH PRIVILEGES;" 2>/dev/null || true
  docker compose exec -T application bash -c "./deploy.sh"
  touch .deployed
fi
docker compose up -d
echo "Fleetbase API  http://localhost:8000   Console http://localhost:4200"
