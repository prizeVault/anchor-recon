import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionBuilder, xdr, scValToNative } from '@stellar/stellar-sdk';
import { args, buildInvoke, decodeAttestation, describeInvoke, encodeCounts } from '../src/attest/registryClient.js';
import { emptyCounts, COUNT_FIELDS } from '../src/attest/entryHash.js';
import { RegistryModel } from '../src/attest/registryModel.js';
import { parseRegistryFromToml, verifyTomlBinding } from '../src/attest/stellarToml.js';

const PASS = 'Test SDF Network ; September 2015';
const CONTRACT = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

test('registry client: Counts encodes as a symbol-keyed map in sorted key order', () => {
  const c = emptyCounts();
  COUNT_FIELDS.forEach((f, i) => (c[f] = i));
  const v = encodeCounts(c);
  const keys = (v as unknown as { map: { key: { sym: { toString(): string } } }[] }).map.map((e) => e.key.sym.toString());
  assert.deepEqual(keys, [...COUNT_FIELDS].sort());
  assert.deepEqual(scValToNative(v), c);
});

test('registry client: attest invoke transaction is built offline and round-trips through XDR', () => {
  const kp = Keypair.random();
  const c = emptyCounts();
  c.matched_groups = 2;
  c.matched_rule = 2;
  const a = args.attest(20683, 'ab'.repeat(32), c, 341250n, 'cd'.repeat(32));
  const tx = buildInvoke({ source: kp.publicKey(), sequence: '100', contractId: CONTRACT, method: 'attest', args: a, passphrase: PASS });
  const back = TransactionBuilder.fromXDR(tx.toXDR(), PASS);
  assert.equal(back.operations.length, 1);
  const op = back.operations[0] as unknown as { type: string; func: { invokeContract: { functionName: { toString(): string }; args: xdr.ScVal[] } } };
  assert.equal(op.type, 'invokeHostFunction');
  const inv = op.func.invokeContract;
  assert.equal(inv.functionName.toString(), 'attest');
  assert.equal(inv.args.length, 5);
  assert.equal(scValToNative(inv.args[0]), 20683);
  assert.equal(scValToNative(inv.args[3]), 341250n);
  const d = describeInvoke('attest', a);
  assert.equal(d.args[1], 'ab'.repeat(32));
  assert.equal(d.args[3], '341250');
  assert.throws(() => args.attest(1, 'ab', c, 0n, 'cd'.repeat(32)), /32 bytes/);
});

test('registry client: every write method encodes its arguments', () => {
  const g = Keypair.random().publicKey();
  assert.equal(args.restate(1, 'aa'.repeat(32), emptyCounts(), 0n, 'bb'.repeat(32), 1).length, 6);
  assert.equal(args.countersign(g, 1, 0, 1, 'aa'.repeat(32)).length, 5);
  assert.equal(args.rotate_signer(g, 2, 1_700_000_000).length, 3);
  assert.equal(args.init({ admin: g, signer: g, startDay: 20668, weekdayMask: 31, graceSecs: 43200, currency: 'EUR', decimals: 2, homeDomain: 'sim-anchor.example' }).length, 8);
  assert.deepEqual(describeInvoke('mark_gaps', args.mark_gaps(20697)).args, [20697]);
});

test('registry client: decodes an Attestation ScVal into the model shape', () => {
  const m = new RegistryModel();
  m.now = 20668 * 86400;
  m.init('A', 'S', 20668, 31, 43200, 'EUR', 2, 'x');
  m.now += 18 * 3600;
  const a = m.attest('S', 20668, 'aa'.repeat(32), emptyCounts(), 5n, 'bb'.repeat(32));
  const sc = xdr.ScVal.scvMap(
    [
      ['attested_at', xdr.ScVal.scvU64(BigInt(a.attestedAt))],
      ['counts', encodeCounts(a.counts)],
      ['day', xdr.ScVal.scvU32(a.day)],
      ['entry_hash', xdr.ScVal.scvBytes(Buffer.from(a.entryHash, 'hex'))],
      ['late', xdr.ScVal.scvBool(a.late)],
      ['reason', xdr.ScVal.scvU32(0)],
      ['report_hash', xdr.ScVal.scvBytes(Buffer.from(a.reportHash, 'hex'))],
      ['root', xdr.ScVal.scvBytes(Buffer.from(a.root, 'hex'))],
      ['seq', xdr.ScVal.scvU64(1n)],
      ['shortfall', args.attest(1, 'aa'.repeat(32), emptyCounts(), 5n, 'bb'.repeat(32))[3]],
      ['signer_epoch', xdr.ScVal.scvU32(0)],
      ['version', xdr.ScVal.scvU32(0)],
    ].map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k as string), val: v as xdr.ScVal })),
  );
  assert.deepEqual(decodeAttestation(sc), a);
});

test('registry model: gaps, declare, countersign and suspect rules mirror the contract', () => {
  const m = new RegistryModel();
  const at = (d: number, h: number) => d * 86400 + h * 3600;
  m.now = at(20668, 7);
  m.init('ADMIN', 'S0', 20668, 31, 43200, 'EUR', 2, 'x');
  assert.throws(() => m.init('ADMIN', 'S0', 20668, 31, 43200, 'EUR', 2, 'x'), /AlreadyInitialised/);
  m.declareNonReconDay('S0', 20669, 1);
  assert.throws(() => m.declareNonReconDay('S0', 20673, 1), /NotExpectedDay/);
  m.now = at(20668, 18);
  m.attest('S0', 20668, 'aa'.repeat(32), emptyCounts(), 0n, 'bb'.repeat(32));
  m.now = at(20672, 13); // Friday 13:00: Wednesday and Thursday are past their deadline
  assert.equal(m.markGaps(20680), 2);
  assert.deepEqual(m.gaps(20668, 20680), [20670, 20671]);
  assert.equal(m.markGaps(20680), 0);
  assert.throws(() => m.gaps(20668, 20668 + 62), /RangeTooLarge/);
  assert.throws(() => m.countersign('AUD', 20668, 0, 1, 'cc'.repeat(32)), /NotAuditor/);
  m.setAuditor('ADMIN', 'AUD', true);
  assert.throws(() => m.countersign('AUD', 20668, 1, 1, 'cc'.repeat(32)), /VersionNotFound/);
  m.countersign('AUD', 20668, 0, 1, 'cc'.repeat(32));
  assert.throws(() => m.countersign('AUD', 20668, 0, 1, 'cc'.repeat(32)), /AlreadyCountersigned/);
  assert.throws(() => m.rotateSigner('ADMIN', 'S0', 1, 0), /SameSigner/);
  m.rotateSigner('ADMIN', 'S1', 2, at(20668, 0));
  assert.equal(m.isSuspect(20668, 0), true);
  assert.throws(() => m.attest('S0', 20672, 'aa'.repeat(32), emptyCounts(), 0n, 'bb'.repeat(32)), /auth/);
  assert.equal(m.status(20670), 'Gap');
  assert.equal(m.status(20669), 'NonReconDay');
  assert.equal(m.status(20673), 'NotExpected');
});

test('stellar.toml: RECON_REGISTRY binding and the reverse home_domain check', () => {
  const toml = `VERSION="2.0.0"\nNETWORK_PASSPHRASE="${PASS}"\nRECON_REGISTRY="${CONTRACT}"\n[DOCUMENTATION]\nORG_NAME="SIM ANCHOR EMI (simulated)"\n`;
  assert.deepEqual(parseRegistryFromToml(toml), { registry: CONTRACT, source: 'top-level' });
  assert.ok(verifyTomlBinding(toml, CONTRACT, 'sim-anchor.example', 'sim-anchor.example').ok);
  assert.equal(verifyTomlBinding(toml, CONTRACT, 'other.example', 'sim-anchor.example').ok, false);
  assert.equal(verifyTomlBinding(toml.replace(CONTRACT, 'CXXX'), CONTRACT, 'sim-anchor.example', 'sim-anchor.example').ok, false);
  const fallback = `[DOCUMENTATION]\nORG_RECON_REGISTRY="https://stellar.expert/explorer/testnet/contract/${CONTRACT}"\n`;
  assert.deepEqual(parseRegistryFromToml(fallback), { registry: CONTRACT, source: 'documentation' });
  assert.deepEqual(parseRegistryFromToml('[DOCUMENTATION]\nRECON_REGISTRY="C1"\n'), { source: 'none' }, 'the key only counts at top level');
});
