// Profile-driven bank CSV ingestion: delimiter, BOM, date format, decimal
// separator, signed amount or separate debit/credit columns, column names.
// The closing balance comes from a profile column (last row) or from an
// analyst-entered --closing value, which is recorded as source "manual".

import { readFileSync } from 'node:fs';
import { parseMoney } from '../core/money.js';
import type { Balance, BankLine } from '../types.js';
import { normaliseNarrative } from './normalise.js';
import type { Statement } from './camt053.js';

export interface CsvProfile {
  delimiter: string;
  bom: boolean;
  dateFormat: 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MM/DD/YYYY';
  decimalSeparator: '.' | ',';
  currency: string;
  columns: {
    bookingDate: string;
    valueDate?: string;
    narrative: string;
    reference?: string;
    counterparty?: string;
    amount?: string; // signed
    debit?: string;
    credit?: string;
    balance?: string;
  };
}

export function parseCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseDate(s: string, fmt: CsvProfile['dateFormat']): string {
  const t = s.trim();
  let y: string, m: string, d: string;
  if (fmt === 'DD/MM/YYYY') [d, m, y] = t.split(/[/.-]/);
  else if (fmt === 'MM/DD/YYYY') [m, d, y] = t.split(/[/.-]/);
  else [y, m, d] = t.split('-');
  if (!y || !m || !d || y.length !== 4) throw new Error(`bad date "${s}" for ${fmt}`);
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

export function parseCsvStatement(
  content: string,
  profile: CsvProfile,
  accountAlias: string,
  stmtId: string,
  opts: { closing?: bigint; closingDate?: string } = {},
): Statement {
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  else if (profile.bom) throw new Error('CSV profile expects a BOM but none was found');
  const rows = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rows.length === 0) throw new Error('empty CSV');
  const header = parseCsvLine(rows[0], profile.delimiter).map((h) => h.trim());
  const col = (name?: string) => {
    if (!name) return -1;
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV column "${name}" not found in header`);
    return i;
  };
  const c = profile.columns;
  const iBook = col(c.bookingDate);
  const iVal = col(c.valueDate);
  const iNarr = col(c.narrative);
  const iRef = col(c.reference);
  const iCp = col(c.counterparty);
  const iAmt = col(c.amount);
  const iDeb = col(c.debit);
  const iCre = col(c.credit);
  const iBal = col(c.balance);
  const money = (s: string) => parseMoney(s, 2, profile.decimalSeparator);
  const lines: BankLine[] = [];
  let lastBal: bigint | undefined;
  let lastDate = '';
  let firstBalBefore: bigint | undefined;
  rows.slice(1).forEach((row, n) => {
    const f = parseCsvLine(row, profile.delimiter);
    const booking = parseDate(f[iBook], profile.dateFormat);
    const value = iVal >= 0 && f[iVal]?.trim() ? parseDate(f[iVal], profile.dateFormat) : booking;
    let signed: bigint;
    if (iAmt >= 0) signed = money(f[iAmt]);
    else {
      const deb = f[iDeb]?.trim() ? money(f[iDeb]) : 0n;
      const cre = f[iCre]?.trim() ? money(f[iCre]) : 0n;
      if (deb !== 0n && cre !== 0n) throw new Error(`CSV row ${n + 2}: both debit and credit set`);
      signed = cre - (deb < 0n ? -deb : deb);
    }
    const raw = f[iNarr] ?? '';
    const ref = iRef >= 0 ? f[iRef]?.trim() : undefined;
    const cp = iCp >= 0 ? f[iCp]?.trim() : undefined;
    lines.push({
      id: `${accountAlias}:${stmtId}:${String(n + 1).padStart(4, '0')}`,
      account: accountAlias,
      direction: signed >= 0n ? 'credit' : 'debit',
      amount: signed < 0n ? -signed : signed,
      currency: profile.currency,
      bookingDate: booking,
      valueDate: value,
      narrative: normaliseNarrative(raw),
      rawNarrative: raw,
      counterparty: cp ? normaliseNarrative(cp) : undefined,
      endToEndId: ref ? ref : undefined,
      reversal: false,
      day: booking,
    });
    if (iBal >= 0 && f[iBal]?.trim()) {
      const b = money(f[iBal]);
      if (firstBalBefore === undefined) firstBalBefore = b - signed;
      lastBal = b;
    }
    lastDate = booking;
  });
  const balances: Balance[] = [];
  const date = opts.closingDate ?? lastDate;
  if (opts.closing !== undefined) {
    balances.push({ account: accountAlias, date, type: 'CLBD', amount: opts.closing, source: 'manual' });
  } else if (lastBal !== undefined) {
    if (firstBalBefore !== undefined) balances.push({ account: accountAlias, date, type: 'OPBD', amount: firstBalBefore, source: 'statement' });
    balances.push({ account: accountAlias, date, type: 'CLBD', amount: lastBal, source: 'statement' });
  }
  return { stmtId, seq: '0', account: accountAlias, lines, balances };
}

export function readCsvFile(path: string, profile: CsvProfile, accountAlias: string, stmtId: string, opts?: { closing?: bigint; closingDate?: string }): Statement {
  return parseCsvStatement(readFileSync(path, 'utf8'), profile, accountAlias, stmtId, opts);
}
