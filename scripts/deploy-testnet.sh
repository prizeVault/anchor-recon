#!/usr/bin/env bash
# Deploys recon_registry to Stellar testnet, initialises it and registers an
# auditor.
#
# NOT EXECUTED in the environment this project was built in: the sandbox could
# not reach soroban-testnet.stellar.org, Horizon or Friendbot. The script
# follows the documented stellar-cli 28 flow and should work from a machine
# with network access. Review before running.
#
# Requires: stellar-cli 28, network access, a built wasm (scripts/build.sh).
# Usage: scripts/deploy-testnet.sh [START_DAY YYYY-MM-DD]
# Env:   GRACE_SECS (default 43200 = 12 h after the day ends; e2e uses 60)
#        WEEKDAY_MASK (default 31 = Mon..Fri), HOME_DOMAIN (default recon.example.org)
# Writes scripts/.testnet.env with the ids for e2e-testnet.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NETWORK="${NETWORK:-testnet}"
START_DAY="${1:-$(date -u +%F)}"
GRACE_SECS="${GRACE_SECS:-43200}"
WEEKDAY_MASK="${WEEKDAY_MASK:-31}"
HOME_DOMAIN="${HOME_DOMAIN:-recon.example.org}"
WASM="$ROOT/target/wasm32v1-none/release/recon_registry.wasm"

if [ ! -f "$WASM" ]; then
  echo "wasm not found, building"; stellar contract build
fi

# 1. Funded identities (Friendbot): admin, signer, a second signer for the
#    rotation, an auditor, and "anyone" (used only for mark_gaps).
for who in rr-admin rr-signer rr-signer2 rr-auditor rr-anyone; do
  if ! stellar keys address "$who" >/dev/null 2>&1; then
    stellar keys generate --global "$who" --network "$NETWORK" --fund
  fi
done
ADMIN=$(stellar keys address rr-admin)
SIGNER=$(stellar keys address rr-signer)
AUDITOR=$(stellar keys address rr-auditor)
echo "admin    $ADMIN"
echo "signer   $SIGNER"
echo "auditor  $AUDITOR"

# 2. Deploy.
CONTRACT_ID=$(stellar contract deploy --wasm "$WASM" --source rr-admin --network "$NETWORK")
echo "registry $CONTRACT_ID"

# 3. init: day numbers count whole days since 1970-01-01 UTC.
START=$(( $(date -u -d "$START_DAY" +%s) / 86400 ))
stellar contract invoke --id "$CONTRACT_ID" --source rr-admin --network "$NETWORK" -- \
  init --admin "$ADMIN" --signer "$SIGNER" --start_day "$START" \
  --weekday_mask "$WEEKDAY_MASK" --grace_secs "$GRACE_SECS" \
  --currency EUR --decimals 2 --home_domain "$HOME_DOMAIN"

# 4. Register the auditor.
stellar contract invoke --id "$CONTRACT_ID" --source rr-admin --network "$NETWORK" -- \
  set_auditor --auditor "$AUDITOR" --active true

cat > "$ROOT/scripts/.testnet.env" <<EOF
RECON_REGISTRY_ID=$CONTRACT_ID
START_DAY=$START_DAY
HOME_DOMAIN=$HOME_DOMAIN
EOF
echo "wrote scripts/.testnet.env (do not commit; it holds only public ids)"
stellar contract invoke --id "$CONTRACT_ID" --source rr-anyone --network "$NETWORK" --send=no -- config
