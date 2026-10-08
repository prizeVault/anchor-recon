// Deterministic seed generator (fixed seed). Everything it writes is
// SIMULATED data for a fictitious "SIM ANCHOR EMI (simulated)" with test
// assets EURC and USDC from a test issuer. No real person, bank or anchor.
//
// Calendar: 2026-08-03 (Mon, day 20668) .. 2026-09-01 (Tue, day 20697);
// 2026-08-31 is a simulated bank holiday, leaving 21 reconciliation days.
// 400 platform transactions (SEP-24 110 dep / 70 wd, SEP-6 35 dep / 25 wd,
// SEP-31 160 receives), ~410 Horizon-shaped chain ops, Bank A CAMT.053
// (safeguarding) and Bank B CSV (payouts), plus the planted breaks K01-K12,
// travel-rule cases T01-T03 and the matchable-but-hard cases, all recorded in
// expected.json.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { BusinessCalendar, dayOf, isoOf } from '../core/dates.js';
import { sha256, sha256Hex } from '../core/hash.js';
import { formatMoney } from '../core/money.js';
import { CROCKFORD, luhn32, makeBankRef, parseRef, damerauLevenshtein } from '../core/reference.js';
import { Rng } from '../core/rng.js';
import { makeMuxed } from '../ingest/horizon.js';
import { normaliseNarrative, stripDiacritics } from '../ingest/normalise.js';
import { requirement } from '../safeguarding/requirement.js';
import type { Kind, PlatformTx, SafeguardingConfig, Sep } from '../types.js';

export const SEED = 'anchor-recon/sim-2026-08';
export const START = '2026-08-03';
export const END = '2026-09-01';
export const HOLIDAYS = ['2026-08-31'];
export const ANCHOR_NAME = 'SIM ANCHOR EMI (simulated)';
export const HOME_DOMAIN = 'sim-anchor.example';

const kp = (label: string) => Keypair.fromRawEd25519Seed(Buffer.from(sha256(`${SEED}|key|${label}`)));
export const ACCOUNTS = {
  issuer: kp('issuer').publicKey(),
  distribution: kp('distribution').publicKey(),
  receive: kp('receive').publicKey(),
};

// ------------------------------------------------------------------ names

const FIRST = [
  'José Luis', 'María José', 'Łukasz', 'Zoë', 'François', 'Ngozi', 'Oluwaseun', 'Aoife', 'Björn', 'Søren', 'Małgorzata', 'Jürgen',
  'Inês', 'João Pedro', 'Chiara', 'Giuseppe', 'Fatima', 'Amara', 'Chukwuemeka', 'Siobhán', 'Mehmet', 'Ayşe', 'Dimitrios', 'Ana',
  'Pedro', 'Lucía', 'Sébastien', 'Hélène', 'Anna', 'Piotr', 'Katarzyna', 'Thomas', 'Emma', 'Liam', 'Sofía', 'Mateus', 'Adaeze',
  'Kwame', 'Nikolaos', 'Eleni', 'Marta', 'Tomás', 'Ioana', 'Andrei', 'Ruth', 'Samuel', 'Grace', 'Wanjiru',
];
const LAST = [
  'Pérez García', 'González Fernández', 'Kowalski', 'Nowak', 'Müller', 'Schröder', "O'Brien", 'Adeyemi', 'Okonkwo', 'Rossi', 'Bianchi',
  'da Silva Santos', 'Ferreira', 'Dubois', 'Lefèvre', 'Papadopoulos', 'Yılmaz', 'Østergaard', 'van der Berg', 'Nwachukwu',
  'Wiśniewski', 'Lewandowska', 'Martín', 'Sánchez', 'Jiménez', 'Moreau', 'Costa', 'Mensah', 'Kamau', 'Popescu', 'Ionescu', 'Novák',
  'Horváth', 'Kovačević', 'Jensen', 'Andersson', 'Fitzgerald', 'Murphy', 'Achterberg', 'Oyelaran',
];
const LONG = [
  'María de los Ángeles Fernández-Castellanos Rubio',
  'Oluwadamilare Babatunde Adewale-Ogunleye',
  'Jean-Baptiste Hippolyte de la Rochefoucauld',
  'Chukwuemeka Obinna Nwankwo-Eze Okafor',
  'Anna-Katharina von Hohenberg-Schwarzenfeld',
  'João Guilherme Vasconcelos de Albuquerque',
  'Małgorzata Aleksandra Wiśniewska-Zielińska',
  'Siobhán Nic Giolla Phádraig Uí Bhriain',
  'Dimitrios Konstantinos Papachristopoulos',
  'Ngozi Chiamaka Onyekachukwu-Ibekwe',
  'Sofía Guadalupe Hernández de la Torre',
  'Frederik Christian Østergaard-Kristiansen',
];

export interface Customer {
  id: string;
  name: string;
  country: string;
}

function makeCustomers(rng: Rng): Customer[] {
  const out: Customer[] = [];
  const seen = new Set<string>();
  const countries = ['ES', 'PL', 'DE', 'FR', 'IE', 'NG', 'PT', 'IT', 'GR', 'TR', 'NL', 'KE', 'GH', 'RO', 'DK'];
  LONG.forEach((n, i) => {
    out.push({ id: `CUS-${String(i + 1).padStart(4, '0')}`, name: n, country: rng.pick(countries) });
    seen.add(n);
  });
  while (out.length < 220) {
    const n = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ id: `CUS-${String(out.length + 1).padStart(4, '0')}`, name: n, country: rng.pick(countries) });
  }
  return out;
}

/** Bank-side rendering of a name: casing, diacritics, order, initials. */
function nameVariant(name: string, rng: Rng): string {
  const plain = normaliseNarrative(name);
  const parts = plain.split(/\s+/);
  const r = rng.next();
  if (r < 0.35) return plain;
  if (r < 0.55 && parts.length >= 2) return [...parts.slice(Math.ceil(parts.length / 2)), ...parts.slice(0, Math.ceil(parts.length / 2))].join(' ');
  if (r < 0.75 && parts.length >= 2) return [parts[0][0], ...parts.slice(1)].join(' ');
  if (r < 0.9) return stripDiacritics(name).toUpperCase();
  return name.toUpperCase();
}

function misspell(name: string, rng: Rng): string {
  const parts = normaliseNarrative(name).split(' ');
  const i = parts.length - 1 - (parts.length > 2 ? rng.int(0, 1) : 0);
  const w = parts[i];
  if (w.length >= 5) {
    const k = rng.int(1, w.length - 3);
    parts[i] = rng.chance(0.5) ? w.slice(0, k) + w[k + 1] + w[k] + w.slice(k + 2) : w.slice(0, k) + w.slice(k + 1);
  }
  return parts.join(' ');
}

// ------------------------------------------------------------------ helpers

const eur = (c: bigint) => formatMoney(c, 2, 2);
const units7 = (c: bigint) => c * 100_000n; // cents -> 7dp
const s7 = (u: bigint) => formatMoney(u, 7, 7);
const hex = (label: string) => sha256Hex(`${SEED}|${label}`);

function uuid(rng: Rng): string {
  const h = rng.hex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function logNormalCents(rng: Rng): bigint {
  const v = Math.exp(Math.log(420) + 1.05 * rng.normal());
  const clamped = Math.min(9800, Math.max(12, v));
  const whole = rng.chance(0.3);
  const cents = whole ? Math.round(clamped) * 100 : Math.round(clamped * 100);
  return BigInt(cents);
}

function feeCents(amount: bigint): bigint {
  const bps = (amount * 50n) / 10_000n;
  return bps > 100n ? bps : 100n;
}

/** One-edit typo of an AR token that the Luhn-32 check digit rejects. */
function typoToken(ref: string, rng: Rng): string {
  const body = ref.slice(3, 11);
  const check = ref.slice(12);
  for (let attempt = 0; attempt < 100; attempt++) {
    let b = body;
    if (rng.chance(0.5)) {
      const i = rng.int(0, 6);
      b = body.slice(0, i) + body[i + 1] + body[i] + body.slice(i + 2);
    } else {
      const i = rng.int(0, 7);
      let c = rng.pick([...CROCKFORD]);
      if (c === body[i]) continue;
      b = body.slice(0, i) + c + body.slice(i + 1);
    }
    if (b === body) continue;
    if (luhn32(b) === check) continue;
    const t = `AR-${b}-${check}`;
    if (damerauLevenshtein(t, ref) === 1 && parseRef(t) && !parseRef(t)!.valid) return t;
  }
  throw new Error('could not build a typo token');
}

function csvMoney(c: bigint): string {
  const s = eur(c);
  const [w, f] = s.split('.');
  const withThousands = w.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${withThousands},${f}`;
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// ------------------------------------------------------------------ model

type Role =
  | 'normal'
  | 'K01' | 'K02' | 'K03' | 'K06' | 'K07' | 'K08' | 'K09' | 'K12'
  | 'T01' | 'T02' | 'T03'
  | 'LATE'
  | 'SPLIT' | 'FEE' | 'TYPO' | 'TRUNC' | 'REVERSAL' | 'FX' | 'CB' | 'MUXED' | 'AMB';

interface Spec {
  sep: Sep;
  kind: Kind;
  day: string;
  role: Role;
  id: string;
  customer: Customer;
  amountIn: bigint; // platform units (EUR cents for deposit; 7dp for chain assets)
  amountOut: bigint;
  amountFee: bigint;
  assetIn: string;
  assetOut: string;
  bankAmount: bigint; // expected bank leg in cents
  nextDay: boolean;
  memo?: string;
  memoType?: 'text' | 'id' | 'hash';
  platformMemoEncoding?: 'hex' | 'base64';
  observedHash: boolean;
  externalId?: string;
  bankRef: string;
  travelRuleRef?: string;
  splitDays?: string[];
  splitParts?: bigint[];
  pathPayment?: boolean;
  muxedId?: string;
  partner?: string;
}

export interface Expected {
  generatedBy: string;
  simulated: true;
  calendar: { start: string; end: string; holidays: string[]; reconciliationDays: string[] };
  counts: { platform: number; bySep: Record<string, number>; chainOps: number; bankA: number; bankB: number; customers: number; travelLog: number };
  planted: { id: string; type: string; subReason?: string; day: string; refs: string[] }[];
  hard: Record<string, { platformId: string; refs: string[]; expectedKind: string }[]>;
  shortfall: Record<string, string>;
  gaps: string[];
  restatement: { day: string; on: string; reason: string };
  lateBankItem: { platformId: string; line: string };
  sweepPolicy: string;
}

interface CamtEntry {
  ref: string;
  amount: bigint;
  dir: 'CRDT' | 'DBIT';
  bookDate: string;
  valDate: string;
  ustrd: string[];
  party?: string;
  e2e?: string;
  charges?: bigint;
  reversal?: boolean;
}

interface CsvRow {
  book: string;
  val: string;
  desc: string;
  ref: string;
  signed: bigint;
}

export interface GenerateResult {
  expected: Expected;
  files: string[];
}

export function generate(outDir: string): GenerateResult {
  const rng = new Rng(SEED);
  const cal = new BusinessCalendar(HOLIDAYS);
  const days = cal.range(dayOf(START), dayOf(END)).map(isoOf);
  const lastDay = days.at(-1)!;
  const nextBd = (d: string, n = 1) => isoOf(cal.add(dayOf(d), n));
  const customers = makeCustomers(rng);
  const longCustomers = customers.slice(0, LONG.length);
  const partners = ['sender-anchor-a.example', 'sender-anchor-b.example', 'sender-anchor-c.example'].map((d, i) => ({ domain: d, account: kp(`partner-${i}`).publicKey() }));

  // ---------------------------------------------------------------- transactions
  const kinds: { sep: Sep; kind: Kind; n: number }[] = [
    { sep: 24, kind: 'deposit', n: 110 },
    { sep: 24, kind: 'withdrawal', n: 70 },
    { sep: 6, kind: 'deposit', n: 35 },
    { sep: 6, kind: 'withdrawal', n: 25 },
    { sep: 31, kind: 'receive', n: 160 },
  ];
  const flat: { sep: Sep; kind: Kind }[] = kinds.flatMap((k) => Array.from({ length: k.n }, () => ({ sep: k.sep, kind: k.kind })));
  rng.shuffle(flat);
  const specs: Spec[] = flat.map((f, i) => {
    const day = days[Math.floor((i * days.length) / flat.length)];
    const id = uuid(rng);
    return {
      ...f,
      day,
      role: 'normal' as Role,
      id,
      customer: rng.pick(customers.slice(LONG.length)),
      amountIn: 0n,
      amountOut: 0n,
      amountFee: 0n,
      assetIn: '',
      assetOut: '',
      bankAmount: 0n,
      nextDay: false,
      observedHash: true,
      bankRef: makeBankRef(id),
    };
  });

  const take = (pred: (s: Spec) => boolean, role: Role, n = 1, day?: string): Spec[] => {
    const got = specs.filter((s) => s.role === 'normal' && pred(s) && (!day || s.day === day)).slice(0, n);
    if (day && got.length < n) {
      // move same-kind transactions from the busiest other days onto the planted day
      const extra = specs.filter((s) => s.role === 'normal' && pred(s) && s.day !== day && s.day !== lastDay).slice(0, n - got.length);
      extra.forEach((s) => (s.day = day));
      got.push(...extra);
    }
    if (got.length < n) throw new Error(`seed: not enough candidates for ${role}`);
    got.forEach((s) => (s.role = role));
    return got;
  };
  const on = (d: string) => (s: Spec) => s.day === d;
  const dep24 = (s: Spec) => s.sep === 24 && s.kind === 'deposit';
  const wd24 = (s: Spec) => s.sep === 24 && s.kind === 'withdrawal';
  const dep6 = (s: Spec) => s.sep === 6 && s.kind === 'deposit';
  const rcv = (s: Spec) => s.sep === 31;
  const payout = (s: Spec) => s.kind !== 'deposit';
  const notLast = (s: Spec) => s.day !== lastDay && s.day !== days.at(-2);

  const K01 = take((s) => dep24(s), 'K01', 1, '2026-08-05')[0];
  const K02 = take((s) => dep6(s) && s.day >= '2026-08-05' && s.day <= '2026-08-07', 'K02')[0];
  const K03 = take((s) => wd24(s), 'K03', 1, '2026-08-07')[0];
  const K06 = take((s) => rcv(s), 'K06', 1, '2026-08-19')[0];
  const K07 = take((s) => rcv(s), 'K07', 1, '2026-08-24')[0];
  const K08 = take((s) => wd24(s), 'K08', 1, '2026-08-10')[0];
  const K09 = take((s) => dep24(s), 'K09', 1, '2026-08-20')[0];
  const K12 = take((s) => dep6(s) && s.day >= '2026-08-10' && s.day <= '2026-08-12', 'K12')[0];
  const T01 = take((s) => rcv(s), 'T01', 1, '2026-08-06')[0];
  const T02 = take((s) => rcv(s), 'T02', 1, '2026-08-13')[0];
  const T03 = take((s) => rcv(s), 'T03', 1, '2026-08-25')[0];
  const LATE = take((s) => wd24(s), 'LATE', 1, '2026-08-12')[0];
  const REV = [
    ...take((s) => wd24(s), 'REVERSAL', 1, '2026-08-05'),
    ...take((s) => wd24(s), 'REVERSAL', 1, '2026-08-11'),
    ...take((s) => wd24(s), 'REVERSAL', 1, '2026-08-18'),
    ...take((s) => wd24(s), 'REVERSAL', 1, '2026-08-26'),
  ];
  const SPLIT_PLAN: [string, number, boolean][] = [
    ['2026-08-04', 2, false],
    ['2026-08-07', 2, true],
    ['2026-08-13', 3, false],
    ['2026-08-17', 2, false],
    ['2026-08-21', 3, true],
    ['2026-08-26', 2, false],
  ];
  const SPLIT = SPLIT_PLAN.map(([d, n, cross]) => {
    const s = take((x) => dep24(x), 'SPLIT', 1, d)[0];
    s.splitDays = Array.from({ length: n }, (_, i) => (cross && i === n - 1 ? nextBd(d) : d));
    return s;
  });
  const CB = take((s) => (dep24(s) || dep6(s)) && ['2026-08-06', '2026-08-14', '2026-08-27'].includes(s.day), 'CB', 3);
  const FEE = take((s) => dep24(s) && notLast(s), 'FEE', 10);
  const TYPO = take((s) => (dep24(s) || dep6(s)) && notLast(s), 'TYPO', 5);
  const FX = take((s) => rcv(s) && notLast(s), 'FX', 5);
  const TRUNC = take((s) => payout(s) && notLast(s), 'TRUNC', 10);
  const MUXED = take((s) => rcv(s), 'MUXED', 12);
  for (const t of TRUNC) t.customer = rng.pick(longCustomers);
  // Ambiguous pair: same customer, same round amount, same day, no reference.
  // The heuristic cannot tell the two bank credits apart (tie broken by
  // platform id) and proposes the crossed pairing; the analyst rejects and
  // matches by hand from the bank's payer details. AMB[0] has the larger id.
  const AMB = take((s) => dep24(s), 'AMB', 2, '2026-08-19').sort((a, b) => (a.id < b.id ? 1 : -1));
  AMB[1].customer = AMB[0].customer;

  // amounts
  const usedBank = new Set<string>(['20000', '19965', '74000', '74035', '48000', '50000', '22500', '25000', '341250']);
  const uniqueCents = (): bigint => {
    for (;;) {
      const c = logNormalCents(rng);
      if (!usedBank.has(c.toString()) && !usedBank.has((c + 35n).toString()) && !usedBank.has((c - 35n).toString())) {
        usedBank.add(c.toString());
        return c;
      }
    }
  };
  for (const s of specs) {
    if (s.kind === 'deposit') {
      s.amountIn = s.role === 'K09' ? 50_000n : s.role === 'AMB' ? 20_000n : uniqueCents();
      s.amountFee = feeCents(s.amountIn);
      s.amountOut = units7(s.amountIn - s.amountFee);
      s.assetIn = 'EUR';
      s.assetOut = 'EURC';
      s.bankAmount = s.amountIn;
    } else if (s.kind === 'withdrawal') {
      const out = s.role === 'K03' ? 25_000n : uniqueCents();
      const fee = feeCents(out);
      s.amountOut = out;
      s.amountFee = units7(fee);
      s.amountIn = units7(out + fee);
      s.assetIn = 'EURC';
      s.assetOut = 'EUR';
      s.bankAmount = out;
    } else {
      const inCents = uniqueCents();
      const fee = inCents * 30n / 10_000n > 100n ? (inCents * 30n) / 10_000n : 100n;
      const ratePpm = BigInt(rng.int(910_000, 931_000));
      const out = ((inCents - fee) * ratePpm) / 1_000_000n;
      usedBank.add(out.toString());
      s.amountIn = units7(inCents);
      s.amountFee = units7(fee);
      s.amountOut = out;
      s.assetIn = 'USDC';
      s.assetOut = 'EUR';
      s.bankAmount = out;
      s.partner = rng.pick(partners).account;
    }
  }
  // split parts
  for (const s of SPLIT) {
    const n = s.splitDays!.length;
    const parts: bigint[] = [];
    let left = s.amountIn;
    for (let i = 0; i < n - 1; i++) {
      const p = (left * BigInt(rng.int(30, 60))) / 100n;
      parts.push(p);
      left -= p;
    }
    parts.push(left);
    s.splitParts = parts;
  }

  // memos, hashes, external ids, travel rule
  let memoCounter = 400_000 + rng.int(0, 9999);
  for (const s of specs) {
    if (s.kind === 'deposit') {
      s.memoType = 'hash';
      s.memo = sha256Hex(s.id);
      s.platformMemoEncoding = rng.chance(0.5) ? 'hex' : 'base64';
    } else {
      const r = rng.next();
      if (s.role === 'MUXED') {
        s.memoType = 'id';
        s.memo = String(++memoCounter);
        s.muxedId = s.memo;
      } else if (r < 0.4) {
        s.memoType = 'id';
        s.memo = String(++memoCounter);
      } else if (r < 0.7) {
        s.memoType = 'text';
        s.memo = s.kind === 'receive' ? `S31-${rng.hex(4).toUpperCase()}` : `WD${String(++memoCounter)}`;
      } else {
        s.memoType = 'hash';
        s.memo = hex(`memo|${s.id}`);
        s.platformMemoEncoding = rng.chance(0.5) ? 'hex' : 'base64';
      }
      s.externalId = `E2E${rng.hex(8).toUpperCase()}`;
      s.observedHash = s.role === 'MUXED' ? false : s.kind === 'receive' ? rng.chance(0.6) : rng.chance(0.5);
    }
    if (s.role === 'CB') s.observedHash = false;
    if (s.kind === 'receive') {
      s.travelRuleRef = rng.chance(0.5) ? hex(`tr|${s.id}`) : `TRP-${rng.hex(6).toUpperCase()}`;
      s.pathPayment = s.role === 'normal' && rng.chance(0.04);
    }
    if (s.role === 'normal' && s.day !== lastDay && rng.chance(0.2)) s.nextDay = true;
  }
  T01.travelRuleRef = '';
  T02.travelRuleRef = hex('tr|not-in-log');
  T03.travelRuleRef = 'TR-REF-MISSING';

  // ---------------------------------------------------------------- timelines
  type Snap = { status: string; completedAt?: string; stellar: boolean; refunded?: boolean; updatedAt: string };
  const exports = new Map<string, Map<string, Snap>>(); // day -> id -> snap
  const setSnap = (d: string, id: string, snap: Snap) => {
    if (!exports.has(d)) exports.set(d, new Map());
    exports.get(d)!.set(id, snap);
  };
  const ts = (d: string, h: number, m: number) => `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}Z`;
  const startedAt = new Map<string, string>();

  for (const s of specs) {
    const st = ts(s.day, rng.int(7, 14), rng.int(0, 59));
    startedAt.set(s.id, st);
    const done = (d: string) => ts(d, 15, rng.int(0, 59));
    if (s.role === 'SPLIT') {
      const last = s.splitDays!.at(-1)!;
      if (last !== s.day) setSnap(s.day, s.id, { status: 'pending_user_transfer_start', stellar: false, updatedAt: st });
      const c = done(last);
      setSnap(last, s.id, { status: 'completed', completedAt: c, stellar: true, updatedAt: c });
    } else if (s.role === 'K08') {
      setSnap(s.day, s.id, { status: 'pending_anchor', stellar: true, updatedAt: st });
      const c = done('2026-08-17');
      setSnap('2026-08-17', s.id, { status: 'completed', completedAt: c, stellar: true, updatedAt: c });
    } else if (s.role === 'K12') {
      setSnap(s.day, s.id, { status: 'error', stellar: true, updatedAt: done(s.day) });
    } else if (s.role === 'REVERSAL') {
      const c = done(s.day);
      setSnap(s.day, s.id, { status: 'completed', completedAt: c, stellar: true, updatedAt: c });
      const r = nextBd(s.day, 2);
      setSnap(r, s.id, { status: 'refunded', completedAt: c, stellar: true, refunded: true, updatedAt: ts(r, 16, rng.int(0, 59)) });
    } else if (s.nextDay) {
      const pend = s.kind === 'deposit' ? 'pending_anchor' : s.kind === 'withdrawal' ? 'pending_anchor' : 'pending_receiver';
      setSnap(s.day, s.id, { status: pend, stellar: s.kind !== 'deposit', updatedAt: done(s.day) });
      const n = nextBd(s.day);
      const c = done(n);
      setSnap(n, s.id, { status: 'completed', completedAt: c, stellar: true, updatedAt: c });
    } else {
      const c = done(s.day);
      setSnap(s.day, s.id, { status: 'completed', completedAt: c, stellar: true, updatedAt: c });
    }
  }

  // ---------------------------------------------------------------- chain ops
  const horizon = new Map<string, Record<string, unknown>[]>(); // day -> records
  let ledger = 58_000_000;
  const ledgerOf = (d: string) => 58_000_000 + (dayOf(d) - dayOf(START)) * 17_280;
  const opIds = new Map<string, string[]>(); // spec id -> op ids of its chain legs
  const txHashes = new Map<string, string>(); // spec id -> primary tx hash
  const refundHash = new Map<string, string>();
  const pushOp = (d: string, rec: Record<string, unknown>) => {
    if (!horizon.has(d)) horizon.set(d, []);
    horizon.get(d)!.push(rec);
  };
  const opRecord = (d: string, label: string, body: Record<string, unknown>, memo?: { type: 'text' | 'id' | 'hash'; value: string }) => {
    ledger = Math.max(ledger + 1, ledgerOf(d) + rng.int(1, 9000));
    const order = rng.int(1, 200);
    const id = ((BigInt(ledger) << 32n) | (BigInt(order) << 12n) | 1n).toString();
    const hash = hex(`tx|${label}`);
    const created = ts(d, rng.int(8, 16), rng.int(0, 59));
    const memoField =
      memo === undefined
        ? { memo_type: 'none' }
        : { memo_type: memo.type, memo: memo.type === 'hash' ? Buffer.from(memo.value, 'hex').toString('base64') : memo.value };
    pushOp(d, {
      id,
      paging_token: id,
      transaction_successful: true,
      created_at: created,
      transaction_hash: hash,
      ...body,
      transaction: { hash, ledger, created_at: created, ...memoField },
    });
    return { id, hash };
  };
  const credit = (code: string) => ({ asset_type: 'credit_alphanum4', asset_code: code, asset_issuer: ACCOUNTS.issuer });
  const userAcct = (s: Spec) => kp(`user|${s.customer.id}`).publicKey();

  for (const s of specs) {
    const snaps = [...exports.entries()].filter(([, m]) => m.has(s.id)).map(([d]) => d).sort();
    if (s.kind === 'deposit') {
      if (s.role === 'K01') {
        txHashes.set(s.id, hex(`tx|never-submitted|${s.id}`));
        continue;
      }
      const deliverDay = s.role === 'SPLIT' ? s.splitDays!.at(-1)! : s.nextDay ? nextBd(s.day) : s.day;
      const memo = { type: 'hash' as const, value: s.memo! };
      if (s.role === 'CB') {
        const cbId = '00000000' + hex(`cb|${s.id}`);
        const r = opRecord(deliverDay, `cb|${s.id}`, {
          type: 'create_claimable_balance',
          type_i: 14,
          source_account: ACCOUNTS.distribution,
          asset: `EURC:${ACCOUNTS.issuer}`,
          amount: s7(s.amountOut),
          claimants: [{ destination: userAcct(s), predicate: { unconditional: true } }],
          balance_id: cbId,
        }, memo);
        opIds.set(s.id, [r.id]);
        txHashes.set(s.id, r.hash);
        (s as Spec & { cbId?: string }).cbId = cbId;
        if (s !== CB[2]) {
          const claimDay = nextBd(deliverDay);
          opRecord(claimDay, `claim|${s.id}`, { type: 'claim_claimable_balance', type_i: 15, source_account: userAcct(s), balance_id: cbId, claimant: userAcct(s), sponsor: ACCOUNTS.distribution, asset: `EURC:${ACCOUNTS.issuer}` });
        }
        continue;
      }
      const r = opRecord(deliverDay, `dep|${s.id}`, { type: 'payment', type_i: 1, source_account: ACCOUNTS.distribution, from: ACCOUNTS.distribution, to: userAcct(s), ...credit('EURC'), amount: s7(s.amountOut) }, memo);
      opIds.set(s.id, [r.id]);
      txHashes.set(s.id, r.hash);
      if (s.role === 'K02') {
        const r2 = opRecord(deliverDay, `dep-dup|${s.id}`, { type: 'payment', type_i: 1, source_account: ACCOUNTS.distribution, from: ACCOUNTS.distribution, to: userAcct(s), ...credit('EURC'), amount: s7(s.amountOut) }, memo);
        opIds.get(s.id)!.push(r2.id);
      }
    } else {
      const from = s.kind === 'receive' ? s.partner! : userAcct(s);
      const code = s.kind === 'receive' ? 'USDC' : 'EURC';
      const memo = s.role === 'MUXED' ? undefined : { type: s.memoType!, value: s.memoType === 'hash' ? s.memo! : s.memo! };
      const body: Record<string, unknown> = s.pathPayment
        ? { type: 'path_payment_strict_send', type_i: 13, source_account: from, from, to: ACCOUNTS.receive, ...credit(code), amount: s7(s.amountIn), source_asset_type: 'native', source_amount: s7(s.amountIn * 9n) }
        : { type: 'payment', type_i: 1, source_account: from, from, to: ACCOUNTS.receive, ...credit(code), amount: s7(s.amountIn) };
      if (s.role === 'MUXED') {
        body.to_muxed = makeMuxed(ACCOUNTS.receive, BigInt(s.muxedId!));
        body.to_muxed_id = s.muxedId;
      }
      const r = opRecord(s.day, `in|${s.id}`, body, memo);
      opIds.set(s.id, [r.id]);
      txHashes.set(s.id, r.hash);
      if (s.role === 'REVERSAL') {
        const rd = nextBd(s.day, 2);
        const rr = opRecord(rd, `refund|${s.id}`, { type: 'payment', type_i: 1, source_account: ACCOUNTS.distribution, from: ACCOUNTS.distribution, to: userAcct(s), ...credit('EURC'), amount: s7(s.amountIn) }, { type: 'hash', value: sha256Hex(s.id) });
        refundHash.set(s.id, rr.hash);
      }
    }
    void snaps;
  }
  // K04 wrong memo (withdrawal inbound, memo matches nothing), K10 unknown USDC inbound
  const K04 = opRecord('2026-08-11', 'K04', { type: 'payment', type_i: 1, source_account: kp('stranger-1').publicKey(), from: kp('stranger-1').publicKey(), to: ACCOUNTS.receive, ...credit('EURC'), amount: s7(units7(31_577n)) }, { type: 'text', value: 'WD-88213-X' });
  const K10 = opRecord('2026-08-26', 'K10', { type: 'payment', type_i: 1, source_account: kp('stranger-2').publicKey(), from: kp('stranger-2').publicKey(), to: ACCOUNTS.receive, ...credit('USDC'), amount: s7(units7(125_000n)) });

  // ---------------------------------------------------------------- platform exports
  const platformRecords = new Map<string, Map<Sep, Record<string, unknown>[]>>();
  const platformState = new Map<string, PlatformTx>(); // for requirement
  const requirementByDay = new Map<string, bigint>();
  const specById = new Map(specs.map((s) => [s.id, s]));
  const asset = (code: string) => (code === 'EUR' ? 'iso4217:EUR' : `stellar:${code}:${ACCOUNTS.issuer}`);
  const amt2 = (code: string, v: bigint) => (code === 'EUR' ? eur(v) : formatMoney(v, 7, 2));
  for (const d of days) {
    const m = exports.get(d);
    if (!m) continue;
    for (const [id, snap] of [...m.entries()].sort()) {
      const s = specById.get(id)!;
      const encodeMemo = s.memoType === 'hash' && s.platformMemoEncoding === 'base64' ? Buffer.from(s.memo!, 'hex').toString('base64') : s.memo;
      const stellarTx =
        snap.stellar && s.observedHash
          ? [{ id: txHashes.get(id), memo: encodeMemo, memo_type: s.memoType, payments: (opIds.get(id) ?? []).slice(0, 1).map((o) => ({ id: o, amount: { amount: amt2(s.kind === 'deposit' ? s.assetOut : s.assetIn, s.kind === 'deposit' ? s.amountOut : s.amountIn), asset: asset(s.kind === 'deposit' ? s.assetOut : s.assetIn) } })) }]
          : [];
      const rec: Record<string, unknown> = {
        id,
        sep: String(s.sep),
        kind: s.kind,
        status: snap.status,
        amount_in: { amount: amt2(s.assetIn, s.amountIn), asset: asset(s.assetIn) },
        amount_out: { amount: amt2(s.assetOut, s.amountOut), asset: asset(s.assetOut) },
        amount_fee: { amount: amt2(s.kind === 'deposit' ? 'EUR' : s.assetIn, s.amountFee), asset: asset(s.kind === 'deposit' ? 'EUR' : s.assetIn) },
        started_at: startedAt.get(id),
        updated_at: snap.updatedAt,
        completed_at: snap.completedAt,
        memo: encodeMemo,
        memo_type: s.memoType,
        stellar_transactions: stellarTx,
        external_transaction_id: s.externalId,
        claimable_balance_id: (s as Spec & { cbId?: string }).cbId,
        bank_ref: s.bankRef,
        customers: s.kind === 'receive' ? { sender: { id: `EXT-${id.slice(0, 6)}` }, receiver: { id: s.customer.id } } : { sender: { id: s.customer.id } },
      };
      if (s.kind === 'receive') {
        rec.quote_id = `q-${id.slice(0, 8)}`;
        rec.travel_rule_ref = s.travelRuleRef;
      }
      if (snap.refunded) rec.refunds = { amount_refunded: { amount: amt2(s.assetIn, s.amountIn), asset: asset(s.assetIn) }, payments: [{ id: refundHash.get(id), id_type: 'stellar', amount: { amount: amt2(s.assetIn, s.amountIn), asset: asset(s.assetIn) } }] };
      if (s.role === 'K01') rec.stellar_transactions = [{ id: txHashes.get(id), memo: encodeMemo, memo_type: 'hash', payments: [] }];
      if (!platformRecords.has(d)) platformRecords.set(d, new Map());
      const bySep = platformRecords.get(d)!;
      if (!bySep.has(s.sep)) bySep.set(s.sep, []);
      bySep.get(s.sep)!.push(rec);
      platformState.set(id, {
        id,
        sep: s.sep,
        kind: s.kind,
        status: snap.status,
        amountIn: s.amountIn,
        assetIn: s.assetIn,
        amountOut: s.amountOut,
        assetOut: s.assetOut,
        amountFee: s.amountFee,
        assetFee: s.assetIn,
        assetOnChain: s.kind === 'deposit' ? s.assetOut : s.assetIn,
        assetFiat: s.kind === 'deposit' ? s.assetIn : s.assetOut,
        stellarTxHashes: [],
        refundTxHashes: [],
        startedAt: startedAt.get(id)!,
      });
    }
    // requirement snapshot recorded after the loop below
    requirementByDay.set(d, requirement(platformState.values(), SG_CONFIG_FOR_SEED(), []).total);
  }

  // ---------------------------------------------------------------- bank lines
  const camt = new Map<string, CamtEntry[]>();
  const csv = new Map<string, CsvRow[]>();
  const addCamt = (d: string, e: Omit<CamtEntry, 'bookDate' | 'valDate' | 'ref'> & { valDate?: string }) => {
    if (!camt.has(d)) camt.set(d, []);
    const ref = `SIMA${d.replace(/-/g, '')}${String(camt.get(d)!.length + 1).padStart(4, '0')}`;
    const entry = { ...e, ref, bookDate: d, valDate: e.valDate ?? d };
    camt.get(d)!.push(entry);
    return `bank-a:SIMA-${d.replace(/-/g, '')}:${ref}`;
  };
  const addCsv = (d: string, r: Omit<CsvRow, 'book' | 'val'> & { val?: string }) => {
    if (!csv.has(d)) csv.set(d, []);
    csv.get(d)!.push({ ...r, book: d, val: r.val ?? d });
    return { day: d, index: csv.get(d)!.length };
  };
  const lineRefs = new Map<string, string[]>(); // spec id -> bank line ids (A) or csv row handles
  const csvHandles = new Map<string, { day: string; index: number }[]>();
  const handle = (id: string, h: { day: string; index: number }) => {
    if (!csvHandles.has(id)) csvHandles.set(id, []);
    csvHandles.get(id)!.push(h);
  };
  const aRef = (id: string, ref: string) => {
    if (!lineRefs.has(id)) lineRefs.set(id, []);
    lineRefs.get(id)!.push(ref);
  };
  const tokenStyle = (ref: string): string => {
    const r = rng.next();
    if (r < 0.7) return ref;
    if (r < 0.85) return ref.replace(/-/g, '');
    return ref.replace(/-/g, ' ');
  };

  for (const s of specs) {
    const name = s.customer.name;
    if (s.kind === 'deposit') {
      const d = s.day;
      if (s.role === 'SPLIT') {
        const party = nameVariant(name, rng);
        s.splitDays!.forEach((pd, i) => {
          const withToken = i === 0 || rng.chance(0.5);
          aRef(s.id, addCamt(pd, { amount: s.splitParts![i], dir: 'CRDT', ustrd: [withToken ? `${s.bankRef} PART ${i + 1}` : `PART ${i + 1} ${party}`], party, e2e: 'NOTPROVIDED' }));
        });
        continue;
      }
      let amount = s.bankAmount;
      let ustrd: string[];
      let party = nameVariant(name, rng);
      let charges: bigint | undefined;
      if (s.role === 'FEE') {
        amount = s.amountIn - 35n;
        if (FEE.indexOf(s) < 7) charges = 35n;
        ustrd = [`${tokenStyle(s.bankRef)} ${party}`];
      } else if (s.role === 'TYPO') {
        party = misspell(name, rng);
        ustrd = [`${typoToken(s.bankRef, rng)} ${party}`];
      } else if (s.role === 'AMB') {
        party = normaliseNarrative(name);
        ustrd = [`DEPOSIT ${party}`];
      } else if (s.role === 'K09') {
        amount = 48_000n;
        ustrd = [`${s.bankRef} ${party}`];
      } else {
        const r = rng.next();
        if (r < 0.55) ustrd = [`${tokenStyle(s.bankRef)} ${party}`];
        else if (r < 0.8) ustrd = [`SEPA CT FROM ${party} REF ${tokenStyle(s.bankRef)}`];
        else ustrd = [`DEPOSIT ${party}`, `REF ${s.bankRef}`];
      }
      aRef(s.id, addCamt(d, { amount, dir: 'CRDT', ustrd, party, e2e: rng.chance(0.6) ? 'NOTPROVIDED' : `PAYER${rng.hex(6).toUpperCase()}`, charges }));
    } else {
      const payDay = s.role === 'K08' ? '2026-08-17' : s.nextDay ? nextBd(s.day) : s.day;
      const nm = normaliseNarrative(name);
      if (s.role === 'TRUNC') {
        const p = rng.int(5, 12);
        const namePart = nm.slice(0, Math.max(3, 35 - 8 - p));
        const desc = `PAYOUT ${namePart} ${s.bankRef}`.slice(0, 35);
        handle(s.id, addCsv(payDay, { desc, ref: '', signed: -s.bankAmount }));
        continue;
      }
      if (s.role === 'LATE') {
        handle(s.id, addCsv(nextBd(payDay), { desc: `SEPA CT ${s.bankRef} ${nm}`.slice(0, 35), ref: s.externalId!, signed: -s.bankAmount, val: payDay }));
        continue;
      }
      let amount = s.bankAmount;
      let ref = rng.chance(0.7) ? s.externalId! : '';
      let desc = `SEPA CT ${s.bankRef} ${nm}`.slice(0, 35);
      if (s.role === 'FX') {
        const bpsOff = BigInt(rng.int(20, 49));
        amount = s.bankAmount - (s.bankAmount * bpsOff) / 10_000n;
        ref = s.externalId!;
      }
      if (s.role === 'K03') {
        amount = 22_500n;
        ref = '';
      }
      handle(s.id, addCsv(payDay, { desc, ref, signed: -amount }));
      if (s.role === 'K06') handle(s.id, addCsv(payDay, { desc, ref, signed: -amount }));
      if (s.role === 'K07') handle(s.id, addCsv(nextBd(payDay), { desc: `RETURN AC04 ${nm}`.slice(0, 35), ref: '', signed: amount }));
      if (s.role === 'REVERSAL') {
        const why = rng.pick(['RETURN AC04', 'RTN R03 NO ACCOUNT', 'REVERSAL AC01 IBAN']);
        handle(s.id, addCsv(nextBd(payDay, 2), { desc: `${why} ${nm}`.slice(0, 35), ref: '', signed: amount }));
      }
    }
  }
  // K05 unidentified credit, K11 rent + top-up, interest, bank charges
  const K05 = addCamt('2026-08-12', { amount: 74_000n, dir: 'CRDT', ustrd: ['TRANSFER'], party: 'M KOWALSKY', e2e: 'NOTPROVIDED' });
  const K11 = addCamt('2026-08-18', { amount: 341_250n, dir: 'DBIT', ustrd: ['OFFICE RENT AUG 2026 SIM PROPERTIES LTD'], party: 'SIM PROPERTIES LTD' });
  addCamt('2026-08-19', { amount: 341_250n, dir: 'CRDT', ustrd: ['SAFEGUARDING TOP-UP FROM OPERATING ACCT'], party: ANCHOR_NAME });
  addCamt('2026-08-03', { amount: 2_500n, dir: 'DBIT', ustrd: ['BANK CHARGES ACCOUNT FEE JUL 2026'] });
  addCamt('2026-08-28', { amount: 1_247n, dir: 'CRDT', ustrd: ['INTEREST AUG 2026'] });

  // sweeps: Bank A holds the requirement plus a buffer (0 on 2026-08-18), the
  // rest is swept to / from the payout account at end of day.
  const K07reversalFrom = nextBd('2026-08-24');
  const shortfall: Record<string, string> = {};
  let openA = 0n;
  let openB = 60_000_000n;
  const balancesA = new Map<string, { open: bigint; close: bigint }>();
  const balancesB = new Map<string, { open: bigint; close: bigint }>();
  for (const d of days) {
    let req = requirementByDay.get(d) ?? requirementByDay.get(days.filter((x) => x < d && requirementByDay.has(x)).at(-1) ?? '') ?? 0n;
    if (d >= K07reversalFrom) req += K07.bankAmount;
    const entries = camt.get(d) ?? [];
    const net = entries.reduce((a, e) => a + (e.dir === 'CRDT' ? e.amount : -e.amount), 0n);
    const rent = d === '2026-08-18' ? 341_250n : 0n;
    const buffer = d === '2026-08-18' ? 0n : BigInt(rng.int(0, 150_000));
    const target = req + buffer;
    const sweep = target - (openA + net + rent); // positive: from B to A
    if (sweep !== 0n) {
      addCamt(d, { amount: sweep > 0n ? sweep : -sweep, dir: sweep > 0n ? 'CRDT' : 'DBIT', ustrd: [sweep > 0n ? 'SWEEP FROM PAYOUT ACCT' : 'SWEEP TO PAYOUT ACCT'], party: ANCHOR_NAME });
      addCsv(d, { desc: sweep > 0n ? 'SWEEP TO SAFEGUARDING ACCT' : 'SWEEP FROM SAFEGUARDING ACCT', ref: '', signed: -sweep });
    }
    const closeA = openA + net + sweep;
    balancesA.set(d, { open: openA, close: closeA });
    shortfall[d] = (req > closeA ? req - closeA : 0n).toString();
    openA = closeA;
    const rows = csv.get(d) ?? [];
    const closeB = openB + rows.reduce((a, r) => a + r.signed, 0n);
    if (closeB < 0n) throw new Error(`seed: bank B negative on ${d}`);
    balancesB.set(d, { open: openB, close: closeB });
    openB = closeB;
  }

  // ---------------------------------------------------------------- write files
  rmSync(outDir, { recursive: true, force: true });
  for (const sub of ['platform', 'chain', 'bank-a', 'bank-b']) mkdirSync(join(outDir, sub), { recursive: true });
  const files: string[] = [];
  const write = (rel: string, content: string) => {
    writeFileSync(join(outDir, rel), content);
    files.push(rel);
  };
  for (const [d, bySep] of [...platformRecords.entries()].sort()) {
    for (const [sep, recs] of [...bySep.entries()].sort((a, b) => a[0] - b[0])) write(`platform/${d}.sep${sep}.json`, JSON.stringify(recs, null, 1) + '\n');
  }
  let chainCount = 0;
  for (const [d, recs] of [...horizon.entries()].sort()) {
    recs.sort((a, b) => (BigInt(a.id as string) < BigInt(b.id as string) ? -1 : 1));
    chainCount += recs.length;
    write(`chain/${d}.json`, JSON.stringify({ _links: { self: { href: `/accounts/${ACCOUNTS.receive}/operations?join=transactions` } }, _embedded: { records: recs } }, null, 1) + '\n');
  }
  // CAMT.053
  const IBAN_A = 'GB00SIMA00000000000001';
  let bankA = 0;
  days.forEach((d, i) => {
    const es = camt.get(d) ?? [];
    bankA += es.length;
    const b = balancesA.get(d)!;
    const bal = (tp: string, v: bigint) =>
      `      <Bal><Tp><CdOrPrtry><Cd>${tp}</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${eur(v < 0n ? -v : v)}</Amt><CdtDbtInd>${v < 0n ? 'DBIT' : 'CRDT'}</CdtDbtInd><Dt><Dt>${d}</Dt></Dt></Bal>`;
    const ntry = es
      .map((e) => {
        const party = e.party ? (e.dir === 'CRDT' ? `<RltdPties><Dbtr><Pty><Nm>${xmlEsc(e.party)}</Nm></Pty></Dbtr></RltdPties>` : `<RltdPties><Cdtr><Pty><Nm>${xmlEsc(e.party)}</Nm></Pty></Cdtr></RltdPties>`) : '';
        const chg = e.charges ? `<Chrgs><TtlChrgsAndTaxAmt Ccy="EUR">${eur(e.charges)}</TtlChrgsAndTaxAmt></Chrgs>` : '';
        return `      <Ntry>
        <NtryRef>${e.ref}</NtryRef>
        <Amt Ccy="EUR">${eur(e.amount)}</Amt>
        <CdtDbtInd>${e.dir}</CdtDbtInd>
        <RvslInd>${e.reversal ? 'true' : 'false'}</RvslInd>
        <Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><Dt>${e.bookDate}</Dt></BookgDt>
        <ValDt><Dt>${e.valDate}</Dt></ValDt>
        <AcctSvcrRef>${e.ref}</AcctSvcrRef>
        ${chg}
        <NtryDtls><TxDtls><Refs><EndToEndId>${e.e2e ?? 'NOTPROVIDED'}</EndToEndId></Refs>${party}<RmtInf>${e.ustrd.map((u) => `<Ustrd>${xmlEsc(u)}</Ustrd>`).join('')}</RmtInf></TxDtls></NtryDtls>
      </Ntry>`;
      })
      .join('\n');
    write(
      `bank-a/${d}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!-- SIMULATED statement for ${ANCHOR_NAME}; not a real bank. -->
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>SIMA-MSG-${d.replace(/-/g, '')}</MsgId><CreDtTm>${d}T18:30:00Z</CreDtTm></GrpHdr>
    <Stmt>
      <Id>SIMA-${d.replace(/-/g, '')}</Id>
      <ElctrncSeqNb>${i + 1}</ElctrncSeqNb>
      <CreDtTm>${d}T18:30:00Z</CreDtTm>
      <Acct><Id><IBAN>${IBAN_A}</IBAN></Id><Ccy>EUR</Ccy><Nm>SAFEGUARDING - CLIENT MONEY</Nm></Acct>
${bal('OPBD', b.open)}
${bal('CLBD', b.close)}
${ntry}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`,
    );
  });
  // Bank B CSV
  let bankB = 0;
  const csvIds = new Map<string, string>(); // "day#index" -> line id
  for (const d of days) {
    const rows = csv.get(d) ?? [];
    bankB += rows.length;
    let bal = balancesB.get(d)!.open;
    const out = ['Booking date;Value date;Description;Reference;Debit;Credit;Balance'];
    rows.forEach((r, i) => {
      bal += r.signed;
      out.push([ddmmyyyy(r.book), ddmmyyyy(r.val), r.desc, r.ref, r.signed < 0n ? csvMoney(-r.signed) : '', r.signed > 0n ? csvMoney(r.signed) : '', csvMoney(bal)].join(';'));
      csvIds.set(`${d}#${i + 1}`, `bank-b:SIMB-${d.replace(/-/g, '')}:${String(i + 1).padStart(4, '0')}`);
    });
    write(`bank-b/${d}.csv`, '﻿' + out.join('\r\n') + '\r\n');
  }
  for (const [id, hs] of csvHandles) for (const h of hs) aRef(id, csvIds.get(`${h.day}#${h.index}`)!);

  // customers, travel log, configs
  write('customers.csv', 'customer_id,full_name,country\n' + customers.map((c) => `${c.id},"${c.name}",${c.country}`).join('\n') + '\n');
  const log = specs.filter((s) => s.kind === 'receive' && !['T01', 'T02', 'T03'].includes(s.role)).map((s) => s.travelRuleRef!);
  write('travel-rule-log.csv', 'envelope_ref,provider,created_at\n' + log.map((r, i) => `${r},${r.startsWith('TRP-') ? 'SIM-TRP' : 'SIM-ENVELOPE'},2026-08-${String(3 + (i % 28)).padStart(2, '0')}`).join('\n') + '\n');
  write('fee-schedule.json', JSON.stringify(FEE_SCHEDULE, null, 2) + '\n');
  write('safeguarding.json', JSON.stringify(SG_CONFIG_FOR_SEED(), null, 2) + '\n');
  write('platform-map.json', JSON.stringify(PLATFORM_MAP_FILE, null, 2) + '\n');
  write('bank-b-profile.json', JSON.stringify(BANK_B_PROFILE, null, 2) + '\n');
  write('registry-plan.json', JSON.stringify(REGISTRY_PLAN, null, 2) + '\n');

  // expected.json
  const pref = (s: Spec) => `ptx:${s.id}`;
  const planted: Expected['planted'] = [
    { id: 'K01', type: 'PLATFORM_NO_CHAIN_LEG', day: K01.day, refs: [pref(K01)] },
    { id: 'K02', type: 'DUPLICATE_CHAIN_PAYMENT', day: K02.day, refs: [pref(K02), ...opIds.get(K02.id)!.map((o) => `op:${o}`)] },
    { id: 'K03', type: 'SHORT_PAYOUT', day: K03.day, refs: [pref(K03), ...lineRefs.get(K03.id)!.map((l) => `bank:${l}`)] },
    { id: 'K04', type: 'WRONG_MEMO', day: '2026-08-11', refs: [`op:${K04.id}`] },
    { id: 'K05', type: 'UNMATCHED_BANK_CREDIT', day: '2026-08-12', refs: [`bank:${K05}`] },
    { id: 'K06', type: 'DUPLICATE_PAYOUT', day: K06.day, refs: [pref(K06), ...lineRefs.get(K06.id)!.map((l) => `bank:${l}`)] },
    { id: 'K07', type: 'REVERSAL_OPEN', day: K07reversalFrom, refs: [pref(K07), `bank:${lineRefs.get(K07.id)![1]}`] },
    { id: 'K08', type: 'STALE_PENDING', day: K08.day, refs: [pref(K08)] },
    { id: 'K09', type: 'AMOUNT_MISMATCH', day: K09.day, refs: [pref(K09), `bank:${lineRefs.get(K09.id)![0]}`] },
    { id: 'K10', type: 'UNMATCHED_CHAIN_IN', day: '2026-08-26', refs: [`op:${K10.id}`] },
    { id: 'K11', type: 'NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING', day: '2026-08-18', refs: [`bank:${K11}`] },
    { id: 'K12', type: 'STATUS_MISMATCH', day: K12.day, refs: [pref(K12)] },
    { id: 'T01', type: 'TRAVEL_RULE_MISSING', subReason: 'EMPTY', day: T01.day, refs: [pref(T01)] },
    { id: 'T02', type: 'TRAVEL_RULE_MISSING', subReason: 'NOT_IN_LOG', day: T02.day, refs: [pref(T02)] },
    { id: 'T03', type: 'TRAVEL_RULE_MISSING', subReason: 'MALFORMED', day: T03.day, refs: [pref(T03)] },
  ];
  const hardEntry = (s: Spec, kind: string) => ({
    platformId: s.id,
    refs: [pref(s), ...(lineRefs.get(s.id) ?? []).map((l) => `bank:${l}`), ...(opIds.get(s.id) ?? []).map((o) => `op:${o}`)],
    expectedKind: kind,
  });
  const expected: Expected = {
    generatedBy: `seed ${SEED}`,
    simulated: true,
    calendar: { start: START, end: END, holidays: HOLIDAYS, reconciliationDays: days },
    counts: {
      platform: specs.length,
      bySep: { sep6: specs.filter((s) => s.sep === 6).length, sep24: specs.filter((s) => s.sep === 24).length, sep31: specs.filter((s) => s.sep === 31).length },
      chainOps: chainCount,
      bankA,
      bankB,
      customers: customers.length,
      travelLog: log.length,
    },
    planted,
    hard: {
      split: SPLIT.map((s) => hardEntry(s, 'split')),
      feeDiff: FEE.map((s) => hardEntry(s, 'fee_diff')),
      typo: TYPO.map((s) => hardEntry(s, 'single')),
      truncated: TRUNC.map((s) => hardEntry(s, 'single')),
      reversal: REV.map((s) => ({ ...hardEntry(s, 'reversal_pair'), refs: [pref(s), ...(lineRefs.get(s.id) ?? []).map((l) => `bank:${l}`)] })),
      fxDiff: FX.map((s) => hardEntry(s, 'fx_diff')),
      claimableBalance: CB.map((s) => hardEntry(s, 'rule:cb_id')),
      muxed: MUXED.map((s) => hardEntry(s, 'rule:muxed_id')),
      ambiguous: AMB.map((s) => hardEntry(s, 'analyst')),
    },
    shortfall,
    gaps: ['2026-08-20'],
    restatement: { day: '2026-08-12', on: '2026-08-13', reason: 'LATE_BANK_ITEM' },
    lateBankItem: { platformId: LATE.id, line: `bank:${lineRefs.get(LATE.id)![0]}` },
    sweepPolicy: 'Bank A closes each day at the requirement plus a random buffer of EUR 0-1,500 (0 on 2026-08-18) by an end-of-day sweep to or from Bank B.',
  };
  write('expected.json', JSON.stringify(expected, null, 2) + '\n');

  // decisions.jsonl: the scripted analyst accepts the proposal that matches
  // each hard case exactly and rejects anything else; closes some exceptions.
  const decisions: Record<string, unknown>[] = [];
  for (const [group, list] of Object.entries(expected.hard)) {
    if (group === 'claimableBalance' || group === 'muxed') continue;
    if (group === 'ambiguous') {
      for (const h of list) decisions.push({ action: 'manual-match', platformId: h.platformId, bankLineIds: lineRefs.get(h.platformId), on: AMB[0].day, by: 'A. Analyst (simulated)', note: 'matched from payer IBAN in the bank portal' });
      continue;
    }
    for (const h of list) {
      const lines = lineRefs.get(h.platformId) ?? [];
      // a reversal proposal carries only the return line (the payout debit is already matched by rule)
      const bankLineIds = group === 'reversal' ? lines.slice(1) : lines;
      decisions.push({ action: 'accept-proposal', platformId: h.platformId, kind: h.expectedKind, bankLineIds, by: 'A. Analyst (simulated)' });
    }
  }
  decisions.push({ action: 'reject-other-proposals', by: 'A. Analyst (simulated)' });
  decisions.push({ action: 'close', planted: 'K08', resolution: 'CHASED_BANK', on: '2026-08-17', by: 'A. Analyst (simulated)' });
  decisions.push({ action: 'close', planted: 'K11', resolution: 'TOPPED_UP', on: '2026-08-19', by: 'C. Compliance (simulated)' });
  decisions.push({ action: 'close', planted: 'T01', resolution: 'TR_DATA_RECEIVED', on: '2026-08-10', by: 'A. Analyst (simulated)' });
  decisions.push({ action: 'close', planted: 'K12', resolution: 'FALSE_POSITIVE', on: '2026-08-14', by: 'A. Analyst (simulated)' });
  decisions.push({ action: 'approve-reports', by: 'C. Compliance (simulated)' });
  write('decisions.jsonl', decisions.map((d) => JSON.stringify(d)).join('\n') + '\n');
  write(
    'README.md',
    `# Seed data (SIMULATED)\n\nGenerated by \`recon seed\` (app/src/seed/generate.ts) from the fixed seed \`${SEED}\`. Every file here is simulated: the anchor ("${ANCHOR_NAME}"), its banks, customers, partner anchors, keys and amounts are fictitious. See expected.json for the planted breaks and hard cases.\n`,
  );
  return { expected, files };
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');
}

export const FEE_SCHEDULE = {
  currency: 'EUR',
  fee_abs: '200',
  fee_bps: 25,
  bank_charges: [
    { code: 'SEPA_IN', amount: '35', description: 'SEPA incoming credit charge (EUR 0.35)' },
    { code: 'SEPA_OUT', amount: '25', description: 'SEPA outgoing payment charge (EUR 0.25)' },
  ],
  fx_band_bps: 50,
};

export function SG_CONFIG_FOR_SEED(): SafeguardingConfig {
  return {
    currency: 'EUR',
    safeguarding_accounts: ['bank-a'],
    owed_states: [
      { kind: 'deposit', statuses: ['pending_anchor', 'pending_stellar'], amount: 'amountIn' },
      { kind: 'withdrawal', statuses: ['pending_anchor', 'pending_external'], amount: 'amountOut' },
      { kind: 'receive', statuses: ['pending_receiver', 'pending_external'], amount: 'amountOut' },
    ],
    include_open_reversals: true,
    allowed_debit_patterns: ['^SWEEP TO ', '^BANK CHARGES '],
    internal_credit_patterns: ['^SWEEP FROM ', '^INTEREST ', '^SAFEGUARDING TOP-UP '],
    expected_accounts: ['bank-a', 'bank-b'],
    stale_days: 3,
    hold_business_days: 1,
    travel_rule_threshold: '0',
    travel_rule_provider_patterns: ['^TRP-[0-9A-F]{12}$'],
    holidays: HOLIDAYS,
    anchor_accounts: { receive: ACCOUNTS.receive, distribution: ACCOUNTS.distribution },
  };
}

export const PLATFORM_MAP_FILE = {
  _note: 'JSON paths into the Anchor Platform 4.8.0 transaction object. Working assumptions; verify against the Platform API schema (docs/ANCHOR-PLATFORM-MAPPING.md). "a|b" = first present.',
  id: 'id',
  sep: 'sep',
  kind: 'kind',
  status: 'status',
  amountIn: 'amount_in.amount',
  assetIn: 'amount_in.asset',
  amountOut: 'amount_out.amount',
  assetOut: 'amount_out.asset',
  amountFee: 'amount_fee.amount|fee_details.total',
  assetFee: 'amount_fee.asset|fee_details.asset',
  memo: 'memo',
  memoType: 'memo_type',
  stellarTransactions: 'stellar_transactions',
  refundPayments: 'refunds.payments',
  claimableBalanceId: 'claimable_balance_id',
  externalId: 'external_transaction_id',
  bankRef: 'bank_ref',
  customerRef: 'customers.sender.id|customers.receiver.id',
  receiverRef: 'customers.receiver.id',
  travelRuleRef: 'travel_rule_ref',
  quoteId: 'quote_id',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  updatedAt: 'updated_at',
};

export const BANK_B_PROFILE = {
  delimiter: ';',
  bom: true,
  dateFormat: 'DD/MM/YYYY',
  decimalSeparator: ',',
  currency: 'EUR',
  columns: { bookingDate: 'Booking date', valueDate: 'Value date', narrative: 'Description', reference: 'Reference', debit: 'Debit', credit: 'Credit', balance: 'Balance' },
};

export const REGISTRY_PLAN = {
  _note: 'Simulated registry plan used by `recon simulate` (registryModel) and mirrored as constants in the Rust scenario test.',
  start_day: 20668,
  weekday_mask: 31,
  grace_secs: 43200,
  currency: 'EUR',
  decimals: 2,
  home_domain: HOME_DOMAIN,
  attest_time_utc: '18:00',
  skip_on_time: ['2026-08-20'],
  mark_gaps: { on: '2026-08-21', at: '13:00' },
  late_attest: { day: '2026-08-20', on: '2026-08-21', at: '16:00' },
  restate: { day: '2026-08-12', on: '2026-08-13', reason: 'late_bank_item' },
  rotate: { on: '2026-08-14', at: '08:00', reason: 'scheduled' },
  declare: { day: '2026-08-31', on: '2026-08-28', reason: 'bank_holiday' },
  countersign: { day: '2026-08-28', version: 0, on: '2026-09-01', at: '10:00', opinion: 'agreed' },
};
