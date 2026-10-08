# Data protection

## Nothing personal on-chain

The registry stores these fields per attestation, and nothing else:

- `day`, `version` and `root`;
- the 12 counts;
- `shortfall` and `report_hash`;
- `signer_epoch`, `attested_at`, `late`, `reason`, `seq` and `entry_hash`.

No names, account numbers, IBANs, addresses, amounts per customer or transaction ids go on-chain.

**What is public by design, and what it reveals.** The counts and the shortfall are public. Daily
counts reveal the anchor's transaction volume, and the shortfall reveals when it was
under-safeguarded. That disclosure is a deliberate product choice, and whether anchors accept it
is killer question 2 in `VALIDATION.md`. If they do not, the registry becomes a private log (for
example, a deployment only the anchor and its auditor read) or is dropped.

## Salted leaves

Each leaf is `sha256(0x00 ‖ salt[16] ‖ JCS(body))` with a CSPRNG salt. Without the salt and the
body, a leaf hash cannot be tested against a guessed transaction. An inclusion proof given to a
partner anchor reveals only that partner's own leaf, plus sibling hashes that are opaque without
their salts.

## The pack stays with the anchor

The pack is `var/<day>/pack*.json`. It holds the salts, bodies and item ids, and it is the
resolution pack for auditors. It never leaves the anchor unless the anchor sends it. Bank
statements, the Platform export and the customer name export (`customers.csv`) are read locally.
The tool is meant to be self-hosted.

## The LLM is off by default

- The default provider is the deterministic `HeuristicProvider`. `LlmProvider` runs only with
  `--provider llm` (or `RECON_PROVIDER=llm`) and `LLM_API_KEY` set.
- Only review-band blocks are sent to the model, never the whole day.
- Customer name tokens are replaced with per-run pseudonyms (`N` + 8 hex characters, salted) before
  any call, unless `LLM_PERSONAL_DATA_ALLOWED=true`. Equal tokens stay equal, but spelling
  similarity is lost. This is why the LLM adds little on name matching without a data-processing
  agreement.
- Model output never reaches the analyst without passing the schema and the guards.

## Keys

The admin, signer and auditor secrets are read from environment variables, and only by the
command that needs each one. `.env` is git-ignored. Rotating the signer is public. A compromise
rotation marks the old epoch's entries after `compromised_since` as suspect. They are restated
by the new signer, never deleted.

## Seed data

Everything in `data/seed/` is simulated, including every name and IBAN-like string.
