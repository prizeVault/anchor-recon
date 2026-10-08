#!/usr/bin/env bash
# Builds the Soroban contract (wasm32v1-none) and the TypeScript CLI.
# Usage: scripts/build.sh [--test]   (--test also runs cargo test and npm test)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== stellar contract build (recon_registry)"
stellar contract build
WASM="$ROOT/target/wasm32v1-none/release/recon_registry.wasm"
echo "   wasm: $WASM ($(wc -c < "$WASM") bytes)"

echo "== npm install + build (app)"
cd "$ROOT/app"
if [ ! -d node_modules ]; then npm install --no-audit --no-fund; fi
npm run build

if [ "${1:-}" = "--test" ]; then
  echo "== cargo test"
  (cd "$ROOT" && cargo test)
  echo "== npm test"
  npm test
fi
echo "== done"
