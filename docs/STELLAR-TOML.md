# stellar.toml binding

The binding runs in both directions, and a verifier checks both:

1. The anchor's `https://<home_domain>/.well-known/stellar.toml` names the registry contract.
2. The registry's `config().home_domain`, set once at `init`, names the anchor's home domain.

## Preferred form: a top-level key

```toml
VERSION="2.7.0"
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
RECON_REGISTRY="C...REGISTRY_CONTRACT_ID"
```

**Verify-first item (b), unverified.** SEP-1 parsers are expected to ignore unknown top-level
keys, but this was not checked against the common parsers (stellar-sdk `StellarToml`,
wallets). If a parser rejects the key, use the fallback.

## Fallback: a URL under `[DOCUMENTATION]`

```toml
[DOCUMENTATION]
ORG_NAME="Example Anchor Ltd"
ORG_RECON_REGISTRY="https://stellar.expert/explorer/public/contract/C...REGISTRY_CONTRACT_ID"
```

The contract id is taken from the last path segment of the URL. The top-level key wins when both
are present.

## Checking it

```bash
recon verify --toml stellar.toml --registry export.json --registry-id C... --domain example-anchor.com
# OK: stellar.toml names the registry and the registry names the home domain
```

`--registry` is an export, either from `recon registry export` or from `simulate`. It supplies
the registry's `home_domain`. The command fails when:

- the toml has no key;
- the toml names another contract;
- the domains differ (compared case-insensitively).

Fetching the toml over HTTPS is left to the caller (`curl -s https://<domain>/.well-known/stellar.toml`).
The CLI reads a local file, so the check also works offline.
