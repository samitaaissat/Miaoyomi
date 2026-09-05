#!/usr/bin/env bash
set -euo pipefail

# Compatibility entry point for contributors who used the former source-built top-level Compose stack.
# Production deployments use docker-compose.yml alone; a checkout uses the development overlay.
root="$(cd "$(dirname "$0")/.." && pwd)"
export MIAOYOMI_COMPOSE_MODE=dev
exec "$root/scripts/miaoyomi-setup.sh" "$@"
