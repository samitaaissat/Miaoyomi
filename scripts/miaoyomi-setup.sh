#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/miaoyomi-config.py
docker compose -f compose.yaml config --quiet
if [[ "${1:-}" != "--config-only" ]]; then
  docker compose -f compose.yaml up -d --build --wait
fi
