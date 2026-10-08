# Attestation format

The TypeScript code (`app/src/attest/*`) and the contract (`contracts/recon_registry`) both
implement this format. They are tied together by the shared vectors in
`app/test/vectors/entry-hash.json` and `merkle.json`: the Rust tests read the same files the
TypeScript tests read, and `recon vectors` regenerates them.

## 1. Leaf

```
leaf = sha256( 0x00 ‖ salt[16] ‖ JCS(body) )
```

- `salt` is 16 bytes, from a CSPRNG in the CLI. `simulate` derives it from the seed, the day and
  the group id. Salting means a proof for one leaf reveals nothing about its siblings.
- `JCS` is RFC 8785 JSON canonicalisation. The `platformIds`, `chainRefs` and `bankRefs` arrays
  are sorted first.
- The `body` fields are `groupId`, `kind` (`match` or `exception`), `method` (`rule`,
  `heuristic`, `llm` or `analyst`), `platformIds`, `chainRefs` (`<txhash>:<op index>`),
  `bankRefs`, `amounts` (strings, in minor units), and optionally `type`, `subReason`, `status`
  and `decidedBy`.
- An exception has an opening leaf, and a closing leaf `<id>#closed` on the day it is closed (see
  `EXCEPTION-TYPES.md`).

## 2. Merkle tree

- Leaves are sorted by hash (lowercase hex), and each node is
  `sha256( 0x01 ‖ left ‖ right )`.
- An odd node at the end of a level is promoted unchanged.
- The root of the empty set is `sha256(0x00)`.
- An inclusion proof is the leaf, its salt and body, and a list of `{ side: L|R, hash }` steps.

## 3. Pack (private, kept by the anchor)

`var/<day>/pack.json`, or `pack.v<n>.json` for a restatement:

```json
{ "format": "anchor-recon-pack/1", "day": "2026-08-12", "version": 1, "root": "<hex>",
  "leaves": [ { "salt": "<32 hex>", "body": { ... }, "hash": "<hex>" } ],
  "counts": { ...12 fields... }, "shortfall": "0", "figuresHash": "<hex>", "reportHash": "<hex>" }
```

The pack is the resolution pack for the day. CASS 15 asks for retrieval within 48 h. The anchor
keeps it: it contains salts and item ids, which are not public.

## 4. On-chain record (public)

`attest(day, root, counts, shortfall, report_hash)` stores the attestation with these fields:

- `day`, `version`, `root` and `counts`;
- `shortfall`, as i128 minor units, never negative;
- `report_hash`;
- `signer_epoch`, `attested_at`, `late` and `reason`;
- `seq`, and the `entry_hash` chained over every version in `seq` order:

```
entry_hash = sha256( prev[32] ‖ day:u32be ‖ version:u32be ‖ root[32] ‖
                     counts × 12 : u32be ‖ shortfall:i128be ‖ report_hash[32] ‖
                     signer_epoch:u32be ‖ attested_at:u64be ‖ late:u8 ‖ reason:u32be )
```

`prev` is the previous entry's hash, or 32 zero bytes for the first entry.

**Counts field order.** This order is part of the hash and must never change:

1. `platform_txs`
2. `chain_ops`
3. `bank_lines`
4. `matched_groups`
5. `matched_rule`
6. `matched_heuristic`
7. `matched_llm`
8. `matched_analyst`
9. `exceptions_new`
10. `exceptions_open`
11. `exceptions_closed`
12. `travel_rule_missing`

`InvalidCounts` is returned unless
`matched_groups == matched_rule + matched_heuristic + matched_llm + matched_analyst`.

**Restatement reasons:** 1 `LATE_BANK_ITEM`, 2 `ERROR_CORRECTION`, 3 `SIGNER_COMPROMISE`,
4 `AUDITOR_ADJUSTMENT`. At most 16 versions per day.

**Countersignature opinions:** 1 `AGREED`, 2 `AGREED_WITH_EXCEPTIONS`, 3 `DISAGREED`, stored
with a `note_hash`. At most 8 per version, one per auditor.

**Day arithmetic:**

- `day` counts whole days since 1970-01-01 UTC.
- `weekday = (day + 3) % 7`, with Monday = 0.
- A day is expected when bit `1 << weekday` of `weekday_mask` is set.
- `deadline = (day + 1) × 86400 + grace_secs`.
- `late = attested_at > deadline`.

## 5. Vector example

`entry-hash.json`, case `genesis-attest`:

```
prev 00…00, day 20668 (2026-08-03), version 0, attestedAt 1785780000, late false, reason 0,
root 89def4b8…50f5, counts [19,20,23,36,33,2,0,1,1,2,0,0], shortfall 0,
reportHash eb6612cd…a5b, signerEpoch 0
→ 0164b585e222a83f215a3c499cdfc24682500fc0029d7e5685ddefe5a75cd34e
```

Rust reproduces this vector twice: by calling `entry_hash` directly, and through live contract
calls in `test::entry_hash_vector_reproduced_by_live_contract_calls`.

## 6. Verification paths

| Who | Command | Checks |
|---|---|---|
| Anyone | `recon verify --chain --registry <export>` | recomputes every entry hash and the head |
| Auditor | `recon verify --day d --pack p --registry <export> [--version n]` | every leaf hash, the root, and the root against the registry |
| Partner anchor | `recon verify --item <id> --proof <proof.json> --registry <export>` | the leaf hash, the path to the root, and the root against the registry |
| Anyone | `recon verify --toml <file> --registry <export> --registry-id C… --domain d` | the SEP-1 binding in both directions (`STELLAR-TOML.md`) |

`recon registry export --from --to --out` builds the export from a deployed registry through RPC
simulation. It is written but was not run in this environment. `simulate` writes the model's
export.
