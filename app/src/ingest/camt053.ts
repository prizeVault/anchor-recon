// ISO 20022 CAMT.053 bank-to-customer statement ingestion (fast-xml-parser).
// Reads Stmt/Id, ElctrncSeqNb, Acct/Id/IBAN|Othr, OPBD/CLBD balances and, per
// Ntry: Amt@Ccy, CdtDbtInd, RvslInd, BookgDt, ValDt, AcctSvcrRef, EndToEndId,
// RmtInf/Ustrd (lines joined), RltdPties Dbtr|Cdtr Nm, Chrgs. Amounts become
// integer cents. Re-importing the same (Stmt/Id, ElctrncSeqNb) is a no-op.

import { readFileSync } from 'node:fs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseMoney } from '../core/money.js';
import type { Balance, BankLine } from '../types.js';
import { normaliseNarrative } from './normalise.js';

export interface Statement {
  stmtId: string;
  seq: string;
  account: string;
  iban?: string;
  lines: BankLine[];
  balances: Balance[];
}

type X = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['Stmt', 'Bal', 'Ntry', 'TxDtls', 'Ustrd'].includes(name),
});

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object') {
    const o = v as X;
    if ('#text' in o) return String(o['#text']);
    return undefined;
  }
  return String(v);
}

function amt(v: unknown): { amount: bigint; ccy: string } {
  const o = v as X;
  const t = text(o);
  if (t === undefined) throw new Error('CAMT: missing amount');
  const ccy = String((o as X)['@Ccy'] ?? '');
  return { amount: parseMoney(t, 2), ccy };
}

function date(v: unknown): string {
  const o = (v ?? {}) as X;
  const d = text(o.Dt) ?? text(o.DtTm) ?? '';
  return d.slice(0, 10);
}

function partyName(p: unknown): string | undefined {
  if (!p) return undefined;
  const o = p as X;
  return text(o.Nm) ?? text((o.Pty as X | undefined)?.Nm);
}

export function parseCamt053(xml: string, accountAlias: string): Statement[] {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`CAMT.053: malformed XML (${valid.err.msg} at line ${valid.err.line})`);
  const doc = parser.parse(xml) as X;
  const root = (doc.Document as X | undefined)?.BkToCstmrStmt as X | undefined;
  if (!root || !Array.isArray(root.Stmt)) throw new Error('CAMT.053: no BkToCstmrStmt/Stmt');
  return (root.Stmt as X[]).map((st) => {
    const stmtId = text(st.Id);
    if (!stmtId) throw new Error('CAMT.053: Stmt without Id');
    const seq = text(st.ElctrncSeqNb) ?? '0';
    const acctId = ((st.Acct as X)?.Id ?? {}) as X;
    const iban = text(acctId.IBAN) ?? text((acctId.Othr as X | undefined)?.Id);
    const balances: Balance[] = ((st.Bal as X[]) ?? []).flatMap((b) => {
      const tp = text(((b.Tp as X)?.CdOrPrtry as X)?.Cd);
      if (tp !== 'OPBD' && tp !== 'CLBD') return [];
      const { amount } = amt(b.Amt);
      const sign = text(b.CdtDbtInd) === 'DBIT' ? -1n : 1n;
      return [{ account: accountAlias, date: date(b.Dt), type: tp, amount: sign * amount, source: 'statement' as const }];
    });
    const lines: BankLine[] = ((st.Ntry as X[]) ?? []).map((n, i) => {
      const { amount, ccy } = amt(n.Amt);
      const dir = text(n.CdtDbtInd);
      if (dir !== 'CRDT' && dir !== 'DBIT') throw new Error(`CAMT.053: bad CdtDbtInd in entry ${i}`);
      const tx = (((n.NtryDtls as X)?.TxDtls as X[]) ?? [])[0] ?? {};
      const ustrd = ((((tx.RmtInf as X) ?? {}).Ustrd as unknown[]) ?? []).map((u) => text(u) ?? '').join(' ');
      const parties = (tx.RltdPties as X) ?? {};
      const counterparty = dir === 'CRDT' ? partyName(parties.Dbtr) : partyName(parties.Cdtr);
      const e2e = text(((tx.Refs as X) ?? {}).EndToEndId);
      const chrgs = (n.Chrgs as X | undefined)?.TtlChrgsAndTaxAmt ?? ((n.Chrgs as X | undefined)?.Rcrd as X | undefined)?.Amt;
      const entryRef = text(n.AcctSvcrRef) ?? text(n.NtryRef) ?? String(i + 1);
      const raw = ustrd.trim();
      return {
        id: `${accountAlias}:${stmtId}:${entryRef}`,
        account: accountAlias,
        direction: dir === 'CRDT' ? 'credit' : 'debit',
        amount,
        currency: ccy,
        bookingDate: date(n.BookgDt),
        valueDate: date(n.ValDt) || date(n.BookgDt),
        narrative: normaliseNarrative(raw),
        rawNarrative: raw,
        counterparty: counterparty ? normaliseNarrative(counterparty) : undefined,
        endToEndId: e2e && e2e !== 'NOTPROVIDED' ? e2e : undefined,
        reversal: text(n.RvslInd) === 'true',
        charges: chrgs ? amt(chrgs).amount : undefined,
        day: date(n.BookgDt),
      };
    });
    return { stmtId, seq, account: accountAlias, iban, lines, balances };
  });
}

/** Tracks imported (Stmt/Id, ElctrncSeqNb) pairs so re-imports are no-ops. */
export class StatementRegistry {
  private seen = new Set<string>();
  constructor(initial: Iterable<string> = []) {
    for (const k of initial) this.seen.add(k);
  }
  accept(st: Statement): boolean {
    const k = `${st.account}|${st.stmtId}|${st.seq}`;
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }
  keys(): string[] {
    return [...this.seen];
  }
}

export function readCamtFile(path: string, accountAlias: string): Statement[] {
  return parseCamt053(readFileSync(path, 'utf8'), accountAlias);
}
