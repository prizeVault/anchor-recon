// Store: the reconciliation state (latest platform snapshots, chain ops, bank
// lines, balances, groups, proposals, exceptions, reports) plus per-day
// output files. MemoryStore keeps it in memory (tests, simulate);
// JsonlStore persists it under --data-dir (default var/):
//   var/state.json                  full state (bigints tagged)
//   var/<day>/groups.jsonl          matched groups of the day
//   var/<day>/proposals.jsonl       proposals raised that day
//   var/<day>/exceptions.jsonl      exceptions opened or closed that day
//   var/<day>/figures.json, report.md, pack.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Balance, BankLine, ChainOp, Group, PlatformTx, Proposal, ReconException } from '../types.js';

export interface LegState {
  chain?: string;
  bank?: string;
  refund: string[];
  blockedChain?: string;
  blockedBank?: string;
}

export interface ReportState {
  day: string;
  kind: 'daily' | 'monthly';
  markdown: string;
  provider: string;
  figuresHash: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface DecisionLog {
  at: string;
  day: string;
  action: string;
  target: string;
  by: string;
  note?: string;
}

export interface ReconState {
  platform: Record<string, PlatformTx>;
  statusSince: Record<string, { status: string; since: string }>;
  firstSeen: Record<string, string>;
  exportDays: Record<string, string[]>; // day -> platform ids in that day's exports
  chain: Record<string, ChainOp>;
  bank: Record<string, BankLine>;
  balances: Balance[];
  statements: string[]; // "account|stmtId|seq"
  statementDays: Record<string, string[]>; // account -> days with a statement
  groups: Group[];
  proposals: Proposal[];
  exceptions: ReconException[];
  itemUse: Record<string, string>; // item id -> "group:<id>" | "exc:<id>" | "prop:<id>" | "internal:<id>"
  legs: Record<string, LegState>;
  processedDays: string[];
  reports: Record<string, ReportState>;
  decisions: DecisionLog[];
  seq: { group: number; proposal: number };
  dirtyDays: string[]; // days whose leaf set changed after processing (late items)
  figures: Record<string, unknown>; // day -> daily figures as computed at that day's cut-off
}

export function emptyState(): ReconState {
  return {
    platform: {},
    statusSince: {},
    firstSeen: {},
    exportDays: {},
    chain: {},
    bank: {},
    balances: [],
    statements: [],
    statementDays: {},
    groups: [],
    proposals: [],
    exceptions: [],
    itemUse: {},
    legs: {},
    processedDays: [],
    reports: {},
    decisions: [],
    seq: { group: 0, proposal: 0 },
    dirtyDays: [],
    figures: {},
  };
}

const BIG = '\u0000big:';

export function serialise(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? BIG + x.toString() : x));
}

export function deserialise<T>(s: string): T {
  return JSON.parse(s, (_k, x) => (typeof x === 'string' && x.startsWith(BIG) ? BigInt(x.slice(BIG.length)) : x)) as T;
}

export interface Store {
  load(): ReconState;
  save(state: ReconState): void;
  writeDay(day: string, name: string, content: string): void;
  readDay(day: string, name: string): string | undefined;
}

export class MemoryStore implements Store {
  private state: ReconState = emptyState();
  readonly files = new Map<string, string>();
  load(): ReconState {
    return this.state;
  }
  save(state: ReconState): void {
    this.state = state;
  }
  writeDay(day: string, name: string, content: string): void {
    this.files.set(`${day}/${name}`, content);
  }
  readDay(day: string, name: string): string | undefined {
    return this.files.get(`${day}/${name}`);
  }
}

export class JsonlStore implements Store {
  constructor(readonly dir: string) {}
  load(): ReconState {
    const p = join(this.dir, 'state.json');
    if (!existsSync(p)) return emptyState();
    return { ...emptyState(), ...deserialise<ReconState>(readFileSync(p, 'utf8')) };
  }
  save(state: ReconState): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'state.json'), serialise(state));
  }
  writeDay(day: string, name: string, content: string): void {
    const d = join(this.dir, day);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), content);
  }
  readDay(day: string, name: string): string | undefined {
    const p = join(this.dir, day, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  }
}

export function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))).join('\n') + (rows.length ? '\n' : '');
}
