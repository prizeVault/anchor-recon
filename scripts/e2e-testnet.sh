#!/usr/bin/env bash
# Five-day journey on testnet: attest, a gap flagged by anyone, a late
# attestation, a scheduled signer rotation, a restatement, an auditor
# countersignature, then offline verification of the on-chain record.
#
# NOT EXECUTED in the environment this project was built in: testnet RPC,
# Horizon and Friendbot were unreachable from the sandbox. Review before
# running.
#
# The packs come from the SIMULATED seed (`recon simulate`); only their
# public fields (day, root, counts, shortfall, report hash) go on-chain.
# The seed days (2026-08-10..14) are in the past, so every attestation is
# flagged late by the contract; that is expected here.
#
# Requires: stellar-cli 28, Node 22, network access.
# Usage: scripts/e2e-testnet.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NETWORK="${NETWORK:-testnet}"
DATA="$ROOT/var/e2e"
RECON="node $ROOT/app/dist/src/cli.js"

scripts/build.sh

# 1. Packs for the month from the simulated seed (offline).
rm -rf "$DATA"
$RECON simulate --days 30 --quiet --data-dir "$DATA" | tail -4

# 2. Deploy + init with START 2026-08-10 and a 60 s grace, register the auditor.
GRACE_SECS=60 scripts/deploy-testnet.sh 2026-08-10
set -a; . scripts/.testnet.env; set +a
ID="$RECON_REGISTRY_ID"
export STELLAR_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
export NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"

daynum() { echo $(( $(date -u -d "$1" +%s) / 86400 )); }
field() { node -e "const p=require(process.argv[1]);const v=p[process.argv[2]];process.stdout.write(typeof v==='object'?JSON.stringify(v):String(v))" "$1" "$2"; }

attest() { # day pack source
  local pack="$DATA/$1/$2"
  stellar contract invoke --id "$ID" --source "$3" --network "$NETWORK" -- attest \
    --day "$(daynum "$1")" --root "$(field "$pack" root)" --counts "$(field "$pack" counts)" \
    --shortfall "$(field "$pack" shortfall)" --report_hash "$(field "$pack" reportHash)"
}
restate() { # day pack source reason
  local pack="$DATA/$1/$2"
  stellar contract invoke --id "$ID" --source "$3" --network "$NETWORK" -- restate \
    --day "$(daynum "$1")" --root "$(field "$pack" root)" --counts "$(field "$pack" counts)" \
    --shortfall "$(field "$pack" shortfall)" --report_hash "$(field "$pack" reportHash)" --reason "$4"
}

# 3. Attest four of the five days; leave 2026-08-13 out.
for d in 2026-08-10 2026-08-11 2026-08-12 2026-08-14; do attest "$d" pack.json rr-signer; done

# 4. Anyone flags the missed day once its deadline (day end + 60 s) has passed.
stellar contract invoke --id "$ID" --source rr-anyone --network "$NETWORK" -- \
  mark_gaps --up_to_day "$(daynum 2026-08-14)"
stellar contract invoke --id "$ID" --source rr-anyone --network "$NETWORK" --send=no -- \
  gaps --from "$(daynum 2026-08-10)" --to "$(daynum 2026-08-14)"

# 5. The missed day is attested late (status GapThenAttested).
attest 2026-08-13 pack.json rr-signer
stellar contract invoke --id "$ID" --source rr-anyone --network "$NETWORK" --send=no -- \
  status --day "$(daynum 2026-08-13)"

# 6. Scheduled rotation to a new signer; the old signer can no longer write.
stellar contract invoke --id "$ID" --source rr-admin --network "$NETWORK" -- \
  rotate_signer --new_signer "$(stellar keys address rr-signer2)" --reason 1 --compromised_since 0
if restate 2026-08-12 pack.v1.json rr-signer 1 2>/dev/null; then
  echo "UNEXPECTED: old signer could still restate"; exit 1
else
  echo "ok: old signer refused after rotation"
fi

# 7. The new signer restates 2026-08-12 (LATE_BANK_ITEM = 1): the Bank B line
#    value-dated 08-12 arrived on 08-13's statement.
restate 2026-08-12 pack.v1.json rr-signer2 1

# 8. Read the registry back and verify offline.
EXPORT="$DATA/testnet-export.json"
$RECON registry export --from 2026-08-10 --to 2026-08-14 --out "$EXPORT"
$RECON verify --chain --registry "$EXPORT"
for d in 2026-08-10 2026-08-11 2026-08-12 2026-08-13 2026-08-14; do
  $RECON verify --day "$d" --pack "$DATA/$d/pack.json" --registry "$EXPORT" --version 0
done
$RECON verify --day 2026-08-12 --pack "$DATA/2026-08-12/pack.v1.json" --registry "$EXPORT" --version 1

# 9. Auditor countersigns 08-12 v1 after an independent verify.
echo "Agreed: reviewed pack v1 for 2026-08-12 against bank statements (SIMULATED)." > "$DATA/audit-note.txt"
AUDITOR_PUBLIC=$(stellar keys address rr-auditor) AUDITOR_SECRET=$(stellar keys secret rr-auditor) \
  $RECON countersign --day 2026-08-12 --version 1 --opinion agreed \
  --pack "$DATA/2026-08-12/pack.v1.json" --note "$DATA/audit-note.txt" --registry "$EXPORT"

# 10. Partner-anchor inclusion proof for one item of 2026-08-11.
ITEM=$(node -e "const p=require('$DATA/2026-08-11/pack.json');const l=p.leaves.find(x=>x.body.kind==='match'&&x.body.platformIds.length);process.stdout.write(l.body.platformIds[0])")
$RECON proof --day 2026-08-11 --item "$ITEM" --pack "$DATA/2026-08-11/pack.json" --out "$DATA/proof.json"
$RECON verify --item "$ITEM" --proof "$DATA/proof.json" --registry "$EXPORT"

# 11. stellar.toml binding (local file standing in for https://$HOME_DOMAIN/.well-known/stellar.toml).
cat > "$DATA/stellar.toml" <<EOF
VERSION="2.7.0"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
RECON_REGISTRY="$ID"

[DOCUMENTATION]
ORG_NAME="SIM ANCHOR EMI (simulated)"
EOF
$RECON verify --toml "$DATA/stellar.toml" --registry "$EXPORT" --registry-id "$ID" --domain "$HOME_DOMAIN"
echo "== e2e done: registry $ID"
