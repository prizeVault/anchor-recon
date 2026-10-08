import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseCsvLine, parseCsvStatement, parseDate, readCsvFile, type CsvProfile } from '../src/ingest/csvBank.js';
import { SEED_DIR } from './helpers.js';

const profile = JSON.parse(readFileSync(join(SEED_DIR, 'bank-b-profile.json'), 'utf8')) as CsvProfile;
const CSV =
  '﻿Booking date;Value date;Description;Reference;Debit;Credit;Balance\r\n' +
  '10/08/2026;10/08/2026;SEPA CT AR-0123ABCD-X MARÍA JOSÉ;E2E123;1.234,56;;98.765,44\r\n' +
  '10/08/2026;07/08/2026;"RETURN AC04; ACME";;;20,00;98.785,44\r\n';

test('csv: profile mapping, BOM, comma decimals, DD/MM, separate debit and credit columns', () => {
  const st = parseCsvStatement(CSV, profile, 'bank-b', 'B-20260810');
  assert.equal(st.lines.length, 2);
  const [a, b] = st.lines;
  assert.equal(a.id, 'bank-b:B-20260810:0001');
  assert.equal(a.direction, 'debit');
  assert.equal(a.amount, 123456n);
  assert.equal(a.bookingDate, '2026-08-10');
  assert.equal(a.endToEndId, 'E2E123');
  assert.equal(a.narrative, 'SEPA CT AR-0123ABCD-X MARIA JOSE');
  assert.equal(b.direction, 'credit');
  assert.equal(b.amount, 2000n);
  assert.equal(b.valueDate, '2026-08-07');
  assert.equal(b.narrative, 'RETURN AC04; ACME', 'quoted field keeps the delimiter');
  assert.deepEqual(
    st.balances.map((x) => [x.type, x.amount, x.source]),
    [
      ['OPBD', 10_000_000n, 'statement'],
      ['CLBD', 9_878_544n, 'statement'],
    ],
  );
});

test('csv: missing BOM is rejected when the profile expects one; manual closing is flagged', () => {
  assert.throws(() => parseCsvStatement(CSV.slice(1), profile, 'bank-b', 'x'), /BOM/);
  const st = parseCsvStatement(CSV, profile, 'bank-b', 'x', { closing: 5n, closingDate: '2026-08-10' });
  assert.deepEqual(st.balances, [{ account: 'bank-b', date: '2026-08-10', type: 'CLBD', amount: 5n, source: 'manual' }]);
});

test('csv: signed amount profile, ISO dates, dot decimals', () => {
  const p: CsvProfile = { delimiter: ',', bom: false, dateFormat: 'YYYY-MM-DD', decimalSeparator: '.', currency: 'EUR', columns: { bookingDate: 'date', narrative: 'text', amount: 'amount' } };
  const st = parseCsvStatement('date,text,amount\n2026-08-10,Payout,-12.50\n2026-08-10,In,3\n', p, 'x', 's');
  assert.deepEqual(st.lines.map((l) => [l.direction, l.amount]), [
    ['debit', 1250n],
    ['credit', 300n],
  ]);
});

test('csv: helpers and errors', () => {
  assert.deepEqual(parseCsvLine('a;"b;c";"d""e"', ';'), ['a', 'b;c', 'd"e']);
  assert.equal(parseDate('01/09/2026', 'DD/MM/YYYY'), '2026-09-01');
  assert.throws(() => parseDate('2026/09/01', 'DD/MM/YYYY'), /bad date/);
  assert.throws(() => parseCsvStatement('﻿foo;bar\n1;2\n', profile, 'x', 's'), /column "Booking date" not found/);
  assert.throws(() => parseCsvStatement('﻿Booking date;Value date;Description;Reference;Debit;Credit;Balance\n10/08/2026;;x;;1,00;2,00;\n', profile, 'x', 's'), /both debit and credit/);
});

test('csv: a seed Bank B file parses; narratives are at most 35 characters', () => {
  const st = readCsvFile(join(SEED_DIR, 'bank-b', '2026-08-13.csv'), profile, 'bank-b', 'SIMB-20260813', { closingDate: '2026-08-13' });
  assert.ok(st.lines.length > 5);
  assert.ok(st.lines.every((l) => l.rawNarrative.length <= 35));
  assert.ok(st.lines.some((l) => l.valueDate === '2026-08-12'), 'late-posted line value-dated the previous day');
});
