# Anchor Recon demo

All data is **simulated** (`data/seed/`, generated from the fixed seed `anchor-recon/sim-2026-08`).
The numbers below are seed-only outputs, not measurements on a real anchor. Parts A to D run
offline. Part E (testnet) was written but **not executed**, because testnet was unreachable from
the build environment.

Run every command from `stellar/anchor-recon/`, with `R="node app/dist/src/cli.js"`.

## 0. Build and test

```bash
cargo test                          # 38 passed (unit, negative, vectors, 300-sequence property, month scenario)
stellar contract build              # target/wasm32v1-none/release/recon_registry.wasm (22,008 bytes)
cd app && npm install && npm test   # 103 pass, 0 fail (offline; no key)
cd ..
```

## A. The month in one command

```bash
$R simulate --days 30 --data-dir var/sim
```

This ingests 30 days of seed files. For each day it matches, applies the scripted analyst
decisions from `data/seed/decisions.jsonl`, approves the report, builds the pack, and attests into
the TypeScript model of the registry. Seeded salts make the roots reproducible. Expected output,
abridged:

```
  2026-08-03 groups+22 proposals 19 exceptions 0 root 52fa1cb94a6a
  ...
  2026-08-13 restated 2026-08-12 as version 1
  ...
  2026-08-21 mark_gaps flagged 1
  ...
SIMULATED DATA ONLY. Seed-only numbers; not a measurement on real anchor data.
planted breaks found with the expected type: 15/15
  K01 PLATFORM_NO_CHAIN_LEG                  found 2026-08-06
  K02 DUPLICATE_CHAIN_PAYMENT                found 2026-08-05
  ...
  K11 NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING   found 2026-08-18
  K12 STATUS_MISMATCH                        found 2026-08-10
  T01 TRAVEL_RULE_MISSING                    found 2026-08-06
  T02 TRAVEL_RULE_MISSING                    found 2026-08-13
  T03 TRAVEL_RULE_MISSING                    found 2026-08-25
exceptions raised: 15 (on planted items 15, other 0)
matchable-hard cases matched: 57/57; hard cases with an exception: 0
proposals: 42 (high 32, review 10); accepted 40, rejected 2
proposal precision (accepted/proposed): 95.2%  fuzzy recall on hard cases: 95.2%
groups: 850 (rule 808, heuristic 40, llm 0, analyst 2; internal lines 45); deterministic share of customer legs 94.8%
shortfall days: 2026-08-18 3412.50 EUR
registry (model): gaps 2026-08-20; restatements 1; attested days 21 (on time 20, late 1)
monthly REP027-style draft (DRAFT, needs approval): var/sim/monthly-2026-08.md
monthly (2026-08): expected 20, on time 19, late 1, gaps 1, restatements 1, shortfall days 1
```

What to look at:

- **The shortfall on 2026-08-18.** A non-customer "OFFICE RENT" debit left the safeguarding
  account (K11), and the 08-19 top-up clears it. See `var/sim/2026-08-18/report.md`.
- **The 08-12 restatement.** A Bank B line value-dated 08-12 arrived on 08-13's statement.
  `var/sim/2026-08-12/pack.v1.json` sits next to `pack.json`, and both versions stay in the
  registry.
- **The gap.** 2026-08-20 was not attested before its deadline. `mark_gaps` (callable by anyone)
  flagged it on 08-21, and it was attested late. 2026-08-31 (a UK bank holiday) was declared a
  non-reconciliation day before its deadline, so it is neither a gap nor expected.
- **`var/sim/monthly-2026-08.md`.** The REP027-style draft. It stays `DRAFT` until a named person
  approves it, and the REP027 field list is not verified.

## B. One day by hand (the analyst's loop)

```bash
D=var/demo; S=data/seed; day=2026-08-03
for k in sep6 sep24 sep31; do $R ingest platform --day $day --file $S/platform/$day.$k.json --data-dir $D; done
$R ingest chain --day $day --file $S/chain/$day.json --data-dir $D
$R ingest bank  --day $day --format camt053 --account bank-a --file $S/bank-a/$day.xml --data-dir $D
$R ingest bank  --day $day --format camt053 --account bank-a --file $S/bank-a/$day.xml --data-dir $D   # re-import
$R ingest bank  --day $day --format csv --profile $S/bank-b-profile.json --account bank-b --file $S/bank-b/$day.csv --data-dir $D
```
```
ingested platform for 2026-08-03: platform 1, chain 0, bank lines 0
ingested platform for 2026-08-03: platform 10, chain 0, bank lines 0
ingested platform for 2026-08-03: platform 8, chain 0, bank lines 0
ingested chain for 2026-08-03: platform 0, chain 19, bank lines 0
ingested bank for 2026-08-03: platform 0, chain 0, bank lines 10
ingested bank for 2026-08-03: platform 0, chain 0, bank lines 0, 1 statement(s) already imported (no-op)
ingested bank for 2026-08-03: platform 0, chain 0, bank lines 12
```

```bash
$R match --day $day --data-dir $D
$R review --day $day --list --data-dir $D
```
```
match 2026-08-03: rule groups 22, proposals 19 (high 13, review 6), new exceptions 0
P-20260803-0001 [pending] high 0.930 fee_diff b3c488d4-... <- bank-a:SIMA-20260803:SIMA202608030001
    reference 1: valid AR token equals bank reference; amount 0.8: difference 35 equals a listed bank charge; date 1; name 0.9
P-20260803-0008 [pending] high 0.957 single 3308741f-... <- bank-a:SIMA-20260803:SIMA202608030008
    reference 0.9: check digit rejects AR-3SJ9KZ3C-G; one-edit correction is AR-3EJ9KZ3C-G; amount 1: amount exact; date 1; name 0.986
P-20260803-0009 [pending] review 0.883 fx_diff bc5134fe-... <- bank-b:BANK-B-20260803:0001
    reference 1: valid AR token equals bank reference; amount 0.8: FX difference 36 bps within 50 bps band; date 1; name 0.667
P-20260803-0012 [pending] review 0.859 single 87dd9111-... <- bank-b:BANK-B-20260803:0004
    reference 0.692: truncated token AR-SX is a prefix of AR-SXT4J73E-B; amount 1: amount exact; date 1; name 0.909
...
```

The gate holds until everything is decided:

```bash
$R attest --day $day --dry-run --data-dir $D
# error: refusing to attest 2026-08-03: 19 undecided proposal(s)

$R review --day $day --accept-band high --by "A. Analyst" --data-dir $D
# accepted 13 high-band proposals; re-check sample: P-20260803-0001, P-20260803-0011
for p in 0009 0010 0012 0013 0014 0017; do
  $R review --day $day --decide P-20260803-$p accept --by "A. Analyst" --data-dir $D
done
# (reject with: --decide <id> reject --by <name> --note <why>; the items return to the pool)
# (close an exception with: --close <exceptionId> --resolution CHASED_BANK|...|FALSE_POSITIVE --by <name>)

$R report --day $day --data-dir $D          # prints the DRAFT daily report (figures below)
$R attest --day $day --dry-run --data-dir $D
# error: refusing to attest 2026-08-03: daily report not approved
$R report --day $day --approve "C. Officer" --data-dir $D
# report 2026-08-03 approved by C. Officer; report_hash c0974858...
$R attest --day $day --dry-run --data-dir $D
```

The report's safeguarding section for this day reads: requirement 0.00, resource (CLBD) 1074.92,
shortfall 0.00, excess 1074.92. The external reconciliation line reads: bank-a internal record
1074.92, bank CLBD 1074.92, difference 0.00.

`attest --dry-run` writes `var/demo/2026-08-03/pack.json` and prints the invocation it would
submit:

```
{ "dryRun": true, "contract": "(RECON_REGISTRY_ID unset)", "method": "attest",
  "args": [ 20668, "<root>", { "bank_lines": 22, "chain_ops": 19, "matched_groups": 41,
            "matched_rule": 22, "matched_heuristic": 19, ... "travel_rule_missing": 0 }, "0", "<report_hash>" ] }
```

The root differs on every run, because the CLI salts leaves from a CSPRNG. `simulate` uses seeded
salts so that its output can be tested.

## C. Verification: auditor and partner anchor

These use the `simulate` output from A. `registry-export.json` is the model registry's full state.

```bash
$R verify --chain --registry var/sim/registry-export.json
# OK: entry-hash chain of 22 entries reproduces head 1f25de9f6a8def47166464ca4b8dd62cd015f2f3dfd14b881408c6b3d758050f

$R verify --day 2026-08-12 --pack var/sim/2026-08-12/pack.json    --registry var/sim/registry-export.json
# OK: 2026-08-12 v0 root 272cb277...c4a8 matches the registry
$R verify --day 2026-08-12 --pack var/sim/2026-08-12/pack.v1.json --registry var/sim/registry-export.json
# OK: 2026-08-12 v1 root 1cc06e6e...f0f0 matches the registry

$R registry status --registry var/sim/registry-export.json      # head, gaps ["2026-08-20"], one row per version
```

**Partner anchor.** A partner anchor checks that one payment is in the attested set, and learns
nothing else about the day:

```bash
$R proof  --day 2026-08-06 --item <platformTxId> --pack var/sim/2026-08-06/pack.json --out proof.json
$R verify --item <platformTxId> --proof proof.json --registry var/sim/registry-export.json
# OK: <platformTxId> is in the attested set of 2026-08-06 v0 (root 56c318d4...11a5)
```

Any platform id that appears in the pack's leaves works, for example the first `platformIds`
entry of `var/sim/2026-08-06/pack.json`.

**Auditor countersignature.** The CLI re-verifies the pack first and refuses on any mismatch:

```bash
echo "Agreed (SIMULATED)" > note.txt
$R countersign --day 2026-08-12 --version 1 --opinion agreed --pack <tampered copy of pack.v1.json> \
   --note note.txt --registry var/sim/registry-export.json --auditor G... --dry-run
# refusing to countersign: pack root 2cc06e6e... != recomputed 1cc06e6e...
$R countersign --day 2026-08-12 --version 1 --opinion agreed --pack var/sim/2026-08-12/pack.v1.json \
   --note note.txt --registry var/sim/registry-export.json --auditor G... --dry-run
# { "dryRun": true, "method": "countersign", "args": [ "G...", 20677, 1, 1, "<sha256 of note.txt>" ] }
```

**stellar.toml binding.** See `docs/STELLAR-TOML.md`. With a file holding
`RECON_REGISTRY="<id>"`:

```bash
$R verify --toml stellar.toml --registry var/sim/registry-export.json --registry-id <id> --domain sim-anchor.example
# OK: stellar.toml names the registry and the registry names the home domain
$R verify --toml stellar.toml --registry var/sim/registry-export.json --registry-id <id> --domain other.example
# FAIL: registry home_domain sim-anchor.example != other.example
```

## D. Registry calls without a network

Every registry write accepts `--dry-run` and prints the exact invocation. `--offline` refuses
instead:

```bash
$R registry init --admin G... --signer G... --start 2026-08-03 --home-domain recon.example.org --dry-run
# args: [admin, signer, 20668, 31, "43200", "EUR", 2, "recon.example.org"]
$R registry gaps --up-to 2026-08-21 --dry-run      # mark_gaps(20686)
$R registry gaps --up-to 2026-08-21 --offline
# error: mark_gaps: --offline set; use --dry-run to print the invocation
```

## E. Testnet (written, NOT executed)

```bash
cp .env.example .env                 # fill in nothing for the scripts; they create keys with stellar-cli
scripts/deploy-testnet.sh 2026-08-10 # deploy + init + set_auditor; writes scripts/.testnet.env
scripts/e2e-testnet.sh               # the full journey below (it calls deploy itself with GRACE_SECS=60)
```

`e2e-testnet.sh` takes these steps:

1. It builds the packs with `simulate` and deploys the registry with a 60 s grace.
2. It attests 2026-08-10, 08-11, 08-12 and 08-14, leaving 08-13 out.
3. `mark_gaps` from an unrelated account flags 08-13, which is then attested late
   (`GapThenAttested`).
4. It rotates the signer (scheduled) and checks that the old signer is refused.
5. The new signer restates 08-12 with `pack.v1.json` (`LATE_BANK_ITEM`).
6. `recon registry export` reads the registry back. `verify --chain` and `verify --day` run
   for every version.
7. The auditor countersigns 08-12 v1.
8. It runs an inclusion proof for one item, then `verify --toml` against a local
   `stellar.toml`.

Because the seed days are in the past, every attestation will carry `late = true`. Expected
results are the `OK:` lines shown in C. The environment's network was unavailable, so none of
this has been observed.
 
