// Soroban client for recon_registry: argument encoding and invoke-transaction
// building (offline, unit-tested), plus simulate/submit and view reads when an
// RPC is reachable (not exercised in this environment). RPC URL and network
// passphrase come from env (STELLAR_RPC_URL, NETWORK_PASSPHRASE).

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { fromHex } from '../core/hash.js';
import { COUNT_FIELDS, type Counts } from './entryHash.js';
import type { ModelAttestation, RegistryExport } from './registryModel.js';

export const u32 = (n: number): xdr.ScVal => xdr.ScVal.scvU32(n);
export const u64 = (n: number | bigint): xdr.ScVal => nativeToScVal(BigInt(n), { type: 'u64' });
export const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: 'i128' });
export const bytes32 = (hex: string): xdr.ScVal => {
  const b = fromHex(hex);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return xdr.ScVal.scvBytes(Buffer.from(b));
};
export const addr = (a: string): xdr.ScVal => new Address(a).toScVal();
export const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
export const str = (s: string): xdr.ScVal => xdr.ScVal.scvString(s);

/** #[contracttype] struct -> ScMap with symbol keys in sorted order. */
export function encodeCounts(c: Counts): xdr.ScVal {
  const entries = [...COUNT_FIELDS]
    .sort()
    .map((k) => new xdr.ScMapEntry({ key: sym(k), val: u32(c[k]) }));
  return xdr.ScVal.scvMap(entries);
}

export const args = {
  init: (p: { admin: string; signer: string; startDay: number; weekdayMask: number; graceSecs: number; currency: string; decimals: number; homeDomain: string }) => [
    addr(p.admin),
    addr(p.signer),
    u32(p.startDay),
    u32(p.weekdayMask),
    u64(p.graceSecs),
    sym(p.currency),
    u32(p.decimals),
    str(p.homeDomain),
  ],
  attest: (day: number, root: string, counts: Counts, shortfall: bigint, reportHash: string) => [u32(day), bytes32(root), encodeCounts(counts), i128(shortfall), bytes32(reportHash)],
  restate: (day: number, root: string, counts: Counts, shortfall: bigint, reportHash: string, reason: number) => [
    u32(day),
    bytes32(root),
    encodeCounts(counts),
    i128(shortfall),
    bytes32(reportHash),
    u32(reason),
  ],
  declare_non_recon_day: (day: number, reason: number) => [u32(day), u32(reason)],
  admin_declare_non_recon_day: (day: number, reason: number) => [u32(day), u32(reason)],
  mark_gaps: (upTo: number) => [u32(upTo)],
  set_auditor: (auditor: string, active: boolean) => [addr(auditor), xdr.ScVal.scvBool(active)],
  countersign: (auditor: string, day: number, version: number, opinion: number, noteHash: string) => [addr(auditor), u32(day), u32(version), u32(opinion), bytes32(noteHash)],
  rotate_signer: (newSigner: string, reason: number, compromisedSince: number) => [addr(newSigner), u32(reason), u64(compromisedSince)],
  set_schedule: (mask: number, grace: number) => [u32(mask), u64(grace)],
  get: (day: number, version: number) => [u32(day), u32(version)],
  latest: (day: number) => [u32(day)],
  versions: (day: number) => [u32(day)],
  status: (day: number) => [u32(day)],
  gaps: (from: number, to: number) => [u32(from), u32(to)],
  head: () => [] as xdr.ScVal[],
  config: () => [] as xdr.ScVal[],
  signer: () => [] as xdr.ScVal[],
  gap_cursor: () => [] as xdr.ScVal[],
};

export type Method = keyof typeof args;

/** Builds an unsigned, unsimulated invoke transaction (offline). */
export function buildInvoke(opts: { source: string; sequence: string; contractId: string; method: Method; args: xdr.ScVal[]; passphrase: string; fee?: string; timeout?: number }): Transaction {
  const account = new Account(opts.source, opts.sequence);
  const contract = new Contract(opts.contractId);
  return new TransactionBuilder(account, { fee: opts.fee ?? BASE_FEE, networkPassphrase: opts.passphrase })
    .addOperation(contract.call(opts.method, ...opts.args))
    .setTimeout(opts.timeout ?? 300)
    .build();
}

/** Describes an invocation for --dry-run output. */
export function describeInvoke(method: Method, a: xdr.ScVal[]): { method: string; args: unknown[] } {
  return { method, args: a.map((v) => { const n = scValToNative(v); return typeof n === 'bigint' ? n.toString() : n instanceof Uint8Array || Buffer.isBuffer(n) ? Buffer.from(n).toString('hex') : n; }) };
}

export function decodeAttestation(v: xdr.ScVal): ModelAttestation | undefined {
  const n = scValToNative(v) as Record<string, unknown> | null | undefined;
  if (!n) return undefined;
  const hex = (x: unknown) => Buffer.from(x as Uint8Array).toString('hex');
  const counts = n.counts as Record<string, number>;
  return {
    day: Number(n.day),
    version: Number(n.version),
    root: hex(n.root),
    counts: Object.fromEntries(COUNT_FIELDS.map((f) => [f, Number(counts[f])])) as Counts,
    shortfall: String(n.shortfall),
    reportHash: hex(n.report_hash),
    signerEpoch: Number(n.signer_epoch),
    attestedAt: Number(n.attested_at),
    late: Boolean(n.late),
    reason: Number(n.reason),
    seq: Number(n.seq),
    entryHash: hex(n.entry_hash),
  };
}

export interface RpcConfig {
  rpcUrl: string;
  passphrase: string;
  contractId: string;
}

export function rpcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RpcConfig {
  const rpcUrl = env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const passphrase = env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
  const contractId = env.RECON_REGISTRY_ID ?? '';
  return { rpcUrl, passphrase, contractId };
}

/** Simulate, assemble, sign and submit (online only). */
export async function invoke(cfg: RpcConfig, secret: string, method: Method, a: xdr.ScVal[]): Promise<unknown> {
  if (!cfg.contractId) throw new Error('RECON_REGISTRY_ID is not set');
  const kp = Keypair.fromSecret(secret);
  const server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith('http://') });
  const acct = await server.getAccount(kp.publicKey());
  const tx = buildInvoke({ source: kp.publicKey(), sequence: acct.sequenceNumber(), contractId: cfg.contractId, method, args: a, passphrase: cfg.passphrase });
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(`submit failed: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 30; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status === 'SUCCESS') return r.returnValue ? scValToNative(r.returnValue) : null;
    if (r.status === 'FAILED') throw new Error(`transaction ${sent.hash} failed`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`transaction ${sent.hash} not confirmed in time`);
}

/** Read-only view through simulation (online only). */
export async function view(cfg: RpcConfig, method: Method, a: xdr.ScVal[], source?: string): Promise<xdr.ScVal | undefined> {
  const server = new rpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith('http://') });
  const src = source ?? Keypair.random().publicKey();
  const tx = buildInvoke({ source: src, sequence: '0', contractId: cfg.contractId, method, args: a, passphrase: cfg.passphrase });
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulation failed: ${sim.error}`);
  return sim.result?.retval;
}

/**
 * Reads a deployed registry into the same export shape `simulate` writes, so
 * `recon verify --chain|--day|--item` and `registry status` work on it
 * (online only; not exercised in this environment). Attestations are read for
 * every day in [fromDay, toDay]; gaps in chunks of MAX_SCAN (62) days.
 * Auditors, countersignatures, signer history and events are not views of
 * the contract and are left empty: index them from contract events.
 */
export async function fetchExport(cfg: RpcConfig, fromDay: number, toDay: number): Promise<RegistryExport> {
  const native = async (m: Method, a: xdr.ScVal[]) => {
    const v = await view(cfg, m, a);
    return v ? scValToNative(v) : undefined;
  };
  const c = (await native('config', [])) as Record<string, unknown>;
  const [signer, epoch] = (await native('signer', [])) as [string, number];
  const [seq, hash] = (await native('head', [])) as [bigint, Uint8Array];
  const gapCursor = Number(await native('gap_cursor', []));
  const attestations: ModelAttestation[] = [];
  for (let d = fromDay; d <= toDay; d++) {
    const n = Number(await native('versions', args.versions(d)));
    for (let v = 0; v < n; v++) {
      const r = await view(cfg, 'get', args.get(d, v));
      const a = r ? decodeAttestation(r) : undefined;
      if (a) attestations.push(a);
    }
  }
  const gaps: Record<string, number> = {};
  for (let d = fromDay; d <= toDay; d += 62) {
    const days = ((await native('gaps', args.gaps(d, Math.min(toDay, d + 61)))) ?? []) as number[];
    for (const g of days) gaps[String(g)] = 0; // flag time is in the `gap` event, not a view
  }
  return {
    model: false,
    config: {
      admin: String(c.admin),
      startDay: Number(c.start_day),
      weekdayMask: Number(c.weekday_mask),
      graceSecs: Number(c.grace_secs),
      currency: String(c.currency),
      decimals: Number(c.decimals),
      homeDomain: String(c.home_domain),
    },
    signer,
    epoch: Number(epoch),
    head: { seq: Number(seq), hash: Buffer.from(hash).toString('hex') },
    gapCursor,
    attestations: attestations.sort((a, b) => a.seq - b.seq),
    gaps,
    nonRecon: {},
    auditors: {},
    cosigs: {},
    epochs: [],
    events: [],
  };
}
