// registryModel: an in-memory TypeScript MODEL of recon_registry's rules,
// used by `recon simulate` and offline verification. It is not the contract.
// The contract itself is tested in Rust (contracts/recon_registry); this model
// mirrors its checks, error codes and entry-hash chain so that the offline
// journey can be exercised without a network.

import { deadline, isExpected, SECS_PER_DAY } from '../core/dates.js';
import { type Counts, entryHash, ZERO32 } from './entryHash.js';

export const ERR = {
  AlreadyInitialised: 1,
  NotInitialised: 2,
  BeforeStart: 3,
  FutureDay: 4,
  AlreadyAttested: 5,
  NotAttested: 6,
  TooManyVersions: 7,
  NegativeShortfall: 8,
  InvalidCounts: 9,
  NotAuditor: 10,
  AlreadyCountersigned: 11,
  TooManyCosigs: 12,
  DeadlinePassed: 13,
  NotExpectedDay: 14,
  BadReason: 15,
  SameSigner: 16,
  BadMask: 17,
  VersionNotFound: 18,
  RangeTooLarge: 19,
} as const;
export type ErrName = keyof typeof ERR;

export class RegistryError extends Error {
  constructor(readonly code: ErrName) {
    super(`registry error ${code} (#${ERR[code]})`);
  }
}

export const RESTATE_REASONS: Record<string, number> = {
  late_bank_item: 1,
  error_correction: 2,
  signer_compromise: 3,
  auditor_adjustment: 4,
};
export const OPINIONS: Record<string, number> = { agreed: 1, agreed_with_exceptions: 2, disagreed: 3 };

export interface ModelAttestation {
  day: number;
  version: number;
  root: string;
  counts: Counts;
  shortfall: string;
  reportHash: string;
  signerEpoch: number;
  attestedAt: number;
  late: boolean;
  reason: number;
  seq: number;
  entryHash: string;
}

export interface ModelCountersig {
  auditor: string;
  opinion: number;
  noteHash: string;
  at: number;
}

export interface ModelEpoch {
  signer: string;
  from: number;
  rotatedReason: number;
  compromisedSince: number;
}

export type DayStatus = 'NotExpected' | 'NonReconDay' | 'Pending' | 'Attested' | 'AttestedLate' | 'Gap' | 'GapThenAttested';

export interface ModelConfig {
  admin: string;
  startDay: number;
  weekdayMask: number;
  graceSecs: number;
  currency: string;
  decimals: number;
  homeDomain: string;
}

export interface RegistryExport {
  /** true: written by the TypeScript model (simulate); false: read from a deployed registry. */
  model: boolean;
  config: ModelConfig;
  signer: string;
  epoch: number;
  head: { seq: number; hash: string };
  gapCursor: number;
  attestations: ModelAttestation[];
  gaps: Record<string, number>;
  nonRecon: Record<string, number>;
  auditors: Record<string, boolean>;
  cosigs: Record<string, ModelCountersig[]>;
  epochs: ModelEpoch[];
  events: { name: string; topic: number | string; data: unknown; at: number }[];
}

export class RegistryModel {
  now = 0;
  cfg?: ModelConfig;
  signer = '';
  epoch = 0;
  head = { seq: 0, hash: ZERO32 };
  gapCursor = 0;
  att = new Map<string, ModelAttestation>();
  versionsOf = new Map<number, number>();
  gapsAt = new Map<number, number>();
  nonRecon = new Map<number, number>();
  auditors = new Map<string, boolean>();
  cosigs = new Map<string, ModelCountersig[]>();
  epochs: ModelEpoch[] = [];
  events: RegistryExport['events'] = [];

  private need(): ModelConfig {
    if (!this.cfg) throw new RegistryError('NotInitialised');
    return this.cfg;
  }
  private emit(name: string, topic: number | string, data: unknown) {
    this.events.push({ name, topic, data, at: this.now });
  }

  init(admin: string, signer: string, startDay: number, weekdayMask: number, graceSecs: number, currency: string, decimals: number, homeDomain: string) {
    if (this.cfg) throw new RegistryError('AlreadyInitialised');
    if (weekdayMask === 0 || weekdayMask >= 128) throw new RegistryError('BadMask');
    this.cfg = { admin, startDay, weekdayMask, graceSecs, currency, decimals, homeDomain };
    this.signer = signer;
    this.epoch = 0;
    this.gapCursor = startDay;
    this.epochs = [{ signer, from: this.now, rotatedReason: 0, compromisedSince: 0 }];
  }

  private validate(counts: Counts, shortfall: bigint) {
    if (shortfall < 0n) throw new RegistryError('NegativeShortfall');
    const s = counts.matched_rule + counts.matched_heuristic + counts.matched_llm + counts.matched_analyst;
    if (s !== counts.matched_groups) throw new RegistryError('InvalidCounts');
  }

  private append(day: number, version: number, root: string, counts: Counts, shortfall: bigint, reportHash: string, reason: number): ModelAttestation {
    const cfg = this.need();
    const late = this.now > deadline(day, cfg.graceSecs);
    const hash = entryHash({ prev: this.head.hash, day, version, root, counts, shortfall, reportHash, signerEpoch: this.epoch, attestedAt: this.now, late, reason });
    const seq = this.head.seq + 1;
    const a: ModelAttestation = {
      day,
      version,
      root,
      counts: { ...counts },
      shortfall: shortfall.toString(),
      reportHash,
      signerEpoch: this.epoch,
      attestedAt: this.now,
      late,
      reason,
      seq,
      entryHash: hash,
    };
    this.att.set(`${day}:${version}`, a);
    this.versionsOf.set(day, version + 1);
    this.head = { seq, hash };
    return a;
  }

  attest(caller: string, day: number, root: string, counts: Counts, shortfall: bigint, reportHash: string): ModelAttestation {
    const cfg = this.need();
    if (caller !== this.signer) throw new Error('auth: caller is not the current signer');
    if (day < cfg.startDay) throw new RegistryError('BeforeStart');
    if (day > Math.floor(this.now / SECS_PER_DAY)) throw new RegistryError('FutureDay');
    if (this.versionsOf.has(day)) throw new RegistryError('AlreadyAttested');
    this.validate(counts, shortfall);
    const a = this.append(day, 0, root, counts, shortfall, reportHash, 0);
    this.emit('attest', day, { version: 0, root, shortfall: a.shortfall, late: a.late, seq: a.seq, entryHash: a.entryHash });
    return a;
  }

  restate(caller: string, day: number, root: string, counts: Counts, shortfall: bigint, reportHash: string, reason: number): number {
    this.need();
    if (caller !== this.signer) throw new Error('auth: caller is not the current signer');
    const n = this.versionsOf.get(day) ?? 0;
    if (n === 0) throw new RegistryError('NotAttested');
    if (reason < 1 || reason > 4) throw new RegistryError('BadReason');
    this.validate(counts, shortfall);
    if (n >= 16) throw new RegistryError('TooManyVersions');
    const a = this.append(day, n, root, counts, shortfall, reportHash, reason);
    this.emit('restate', day, { version: n, reason, entryHash: a.entryHash });
    return n;
  }

  declareNonReconDay(caller: string, day: number, reason: number) {
    const cfg = this.need();
    if (caller !== this.signer && caller !== cfg.admin) throw new Error('auth: signer or admin required');
    if (reason !== 1 && reason !== 2) throw new RegistryError('BadReason');
    if (day < cfg.startDay) throw new RegistryError('BeforeStart');
    if (!isExpected(cfg.weekdayMask, day)) throw new RegistryError('NotExpectedDay');
    if (this.now >= deadline(day, cfg.graceSecs)) throw new RegistryError('DeadlinePassed');
    if (this.versionsOf.has(day)) throw new RegistryError('AlreadyAttested');
    this.nonRecon.set(day, reason);
    this.emit('nonrecon', day, { reason });
  }

  markGaps(upToDay: number): number {
    const cfg = this.need();
    let d = this.gapCursor;
    let scanned = 0;
    let flagged = 0;
    while (d <= upToDay && scanned < 62) {
      if (this.now <= deadline(d, cfg.graceSecs)) break;
      const skip = !isExpected(cfg.weekdayMask, d) || this.nonRecon.has(d) || this.versionsOf.has(d);
      if (!skip) {
        this.gapsAt.set(d, this.now);
        this.emit('gap', d, null);
        flagged++;
      }
      d++;
      scanned++;
    }
    this.gapCursor = d;
    return flagged;
  }

  setAuditor(caller: string, auditor: string, active: boolean) {
    const cfg = this.need();
    if (caller !== cfg.admin) throw new Error('auth: admin required');
    this.auditors.set(auditor, active);
    this.emit('auditor', auditor, { active });
  }

  countersign(auditor: string, day: number, version: number, opinion: number, noteHash: string) {
    this.need();
    if (!this.auditors.get(auditor)) throw new RegistryError('NotAuditor');
    if (!this.att.has(`${day}:${version}`)) throw new RegistryError('VersionNotFound');
    if (opinion < 1 || opinion > 3) throw new RegistryError('BadReason');
    const key = `${day}:${version}`;
    const list = this.cosigs.get(key) ?? [];
    if (list.some((c) => c.auditor === auditor)) throw new RegistryError('AlreadyCountersigned');
    if (list.length >= 8) throw new RegistryError('TooManyCosigs');
    list.push({ auditor, opinion, noteHash, at: this.now });
    this.cosigs.set(key, list);
    this.emit('cosign', day, { version, auditor, opinion });
  }

  rotateSigner(caller: string, newSigner: string, reason: number, compromisedSince: number): number {
    const cfg = this.need();
    if (caller !== cfg.admin) throw new Error('auth: admin required');
    if (reason !== 1 && reason !== 2) throw new RegistryError('BadReason');
    if (newSigner === this.signer) throw new RegistryError('SameSigner');
    const cur = this.epochs[this.epoch];
    cur.rotatedReason = reason;
    cur.compromisedSince = reason === 2 ? compromisedSince : 0;
    this.epoch += 1;
    this.epochs.push({ signer: newSigner, from: this.now, rotatedReason: 0, compromisedSince: 0 });
    this.signer = newSigner;
    this.emit('rotate', this.epoch, { newSigner, reason });
    return this.epoch;
  }

  get(day: number, version: number): ModelAttestation | undefined {
    return this.att.get(`${day}:${version}`);
  }

  latest(day: number): ModelAttestation | undefined {
    const n = this.versionsOf.get(day) ?? 0;
    return n ? this.get(day, n - 1) : undefined;
  }

  versions(day: number): number {
    return this.versionsOf.get(day) ?? 0;
  }

  status(day: number): DayStatus {
    const cfg = this.need();
    const gap = this.gapsAt.has(day);
    if (this.versions(day) > 0) {
      if (gap) return 'GapThenAttested';
      return this.get(day, 0)!.late ? 'AttestedLate' : 'Attested';
    }
    if (this.nonRecon.has(day)) return 'NonReconDay';
    if (gap) return 'Gap';
    if (day < cfg.startDay || !isExpected(cfg.weekdayMask, day)) return 'NotExpected';
    return 'Pending';
  }

  gaps(from: number, to: number): number[] {
    if (to < from) return [];
    if (to - from >= 62) throw new RegistryError('RangeTooLarge');
    const out: number[] = [];
    for (let d = from; d <= to; d++) if (this.gapsAt.has(d)) out.push(d);
    return out;
  }

  isSuspect(day: number, version: number): boolean {
    const a = this.get(day, version);
    if (!a) return false;
    const e = this.epochs[a.signerEpoch];
    return !!e && e.rotatedReason === 2 && a.attestedAt >= e.compromisedSince;
  }

  export(): RegistryExport {
    const cfg = this.need();
    return {
      model: true,
      config: cfg,
      signer: this.signer,
      epoch: this.epoch,
      head: this.head,
      gapCursor: this.gapCursor,
      attestations: [...this.att.values()].sort((a, b) => a.seq - b.seq),
      gaps: Object.fromEntries([...this.gapsAt].map(([d, t]) => [String(d), t])),
      nonRecon: Object.fromEntries([...this.nonRecon].map(([d, r]) => [String(d), r])),
      auditors: Object.fromEntries(this.auditors),
      cosigs: Object.fromEntries(this.cosigs),
      epochs: this.epochs,
      events: this.events,
    };
  }
}

/** Recomputes the entry-hash chain of an export (or of real registry data). */
export function verifyChain(atts: ModelAttestation[], fromSeq = 1): { ok: boolean; head: string; brokenAt?: number } {
  const sorted = [...atts].sort((a, b) => a.seq - b.seq);
  let prev = ZERO32;
  for (const a of sorted) {
    const h = entryHash({
      prev,
      day: a.day,
      version: a.version,
      root: a.root,
      counts: a.counts,
      shortfall: BigInt(a.shortfall),
      reportHash: a.reportHash,
      signerEpoch: a.signerEpoch,
      attestedAt: a.attestedAt,
      late: a.late,
      reason: a.reason,
    });
    if (a.seq >= fromSeq && h !== a.entryHash) return { ok: false, head: prev, brokenAt: a.seq };
    prev = a.entryHash;
  }
  return { ok: true, head: prev };
}
