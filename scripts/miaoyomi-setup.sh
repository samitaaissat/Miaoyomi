#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${MIAOYOMI_COMPOSE_MODE:-production}"
compose=(docker compose -f docker-compose.yml)
case "$mode" in
  production) ;;
  dev) compose+=(-f docker-compose.dev.yml) ;;
  *)
    echo "MIAOYOMI_COMPOSE_MODE must be production or dev" >&2
    exit 2
    ;;
esac
python3 scripts/miaoyomi-config.py
"${compose[@]}" config --quiet
if [[ "${1:-}" != "--config-only" ]]; then
  up=(up -d --wait)
  if [[ "$mode" == dev ]]; then
    up+=(--build)
  fi
  "${compose[@]}" "${up[@]}"
fi
