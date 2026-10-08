import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseCamt053, readCamtFile, StatementRegistry } from '../src/ingest/camt053.js';
import { ingestInto } from '../src/match/engine.js';
import { emptyState } from '../src/store/store.js';
import { SEED_DIR } from './helpers.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
 <BkToCstmrStmt><GrpHdr><MsgId>M1</MsgId></GrpHdr>
  <Stmt>
   <Id>ST-1</Id><ElctrncSeqNb>7</ElctrncSeqNb>
   <Acct><Id><IBAN>GB00TEST00000000000001</IBAN></Id></Acct>
   <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-08-10</Dt></Dt></Bal>
   <Bal><Tp><CdOrPrtry><Cd>ITBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-08-10</Dt></Dt></Bal>
   <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">12.34</Amt><CdtDbtInd>DBIT</CdtDbtInd><Dt><Dt>2026-08-10</Dt></Dt></Bal>
   <Ntry><NtryRef>E1</NtryRef><Amt Ccy="EUR">1234.56</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>false</RvslInd>
    <BookgDt><Dt>2026-08-10</Dt></BookgDt><ValDt><Dt>2026-08-09</Dt></ValDt><AcctSvcrRef>REF-1</AcctSvcrRef>
    <Chrgs><TtlChrgsAndTaxAmt Ccy="EUR">0.35</TtlChrgsAndTaxAmt></Chrgs>
    <NtryDtls><TxDtls><Refs><EndToEndId>E2E-PAYER-1</EndToEndId></Refs>
     <RltdPties><Dbtr><Pty><Nm>José Pérez</Nm></Pty></Dbtr></RltdPties>
     <RmtInf><Ustrd>DEPOSIT JOSÉ</Ustrd><Ustrd>REF AR-0123ABCD-X</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
   <Ntry><Amt Ccy="EUR">20</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>true</RvslInd>
    <BookgDt><Dt>2026-08-10</Dt></BookgDt><AcctSvcrRef>REF-2</AcctSvcrRef>
    <NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs><RltdPties><Cdtr><Nm>ACME LTD</Nm></Cdtr></RltdPties><RmtInf><Ustrd>RETURN AC04</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  </Stmt>
 </BkToCstmrStmt>
</Document>`;

test('camt053: balances OPBD/CLBD with sign, other balance types ignored', () => {
  const [st] = parseCamt053(XML, 'bank-a');
  assert.equal(st.stmtId, 'ST-1');
  assert.equal(st.seq, '7');
  assert.equal(st.iban, 'GB00TEST00000000000001');
  assert.deepEqual(
    st.balances.map((b) => [b.type, b.amount]),
    [
      ['OPBD', 100000n],
      ['CLBD', -1234n],
    ],
  );
});

test('camt053: entries, minor units, value date, charges, E2E, counterparty', () => {
  const [st] = parseCamt053(XML, 'bank-a');
  const [a, b] = st.lines;
  assert.equal(a.id, 'bank-a:ST-1:REF-1');
  assert.equal(a.amount, 123456n);
  assert.equal(a.direction, 'credit');
  assert.equal(a.valueDate, '2026-08-09');
  assert.equal(a.bookingDate, '2026-08-10');
  assert.equal(a.charges, 35n);
  assert.equal(a.endToEndId, 'E2E-PAYER-1');
  assert.equal(a.counterparty, 'JOSE PEREZ');
  assert.equal(b.amount, 2000n);
  assert.equal(b.direction, 'debit');
  assert.equal(b.endToEndId, undefined, 'NOTPROVIDED is dropped');
  assert.equal(b.counterparty, 'ACME LTD');
  assert.equal(b.valueDate, '2026-08-10', 'missing ValDt falls back to BookgDt');
});

test('camt053: multi-line Ustrd joined and normalised; RvslInd read', () => {
  const [st] = parseCamt053(XML, 'bank-a');
  assert.equal(st.lines[0].narrative, 'DEPOSIT JOSE REF AR-0123ABCD-X');
  assert.equal(st.lines[0].rawNarrative, 'DEPOSIT JOSÉ REF AR-0123ABCD-X');
  assert.equal(st.lines[0].reversal, false);
  assert.equal(st.lines[1].reversal, true);
});

test('camt053: malformed XML and missing structure are rejected', () => {
  assert.throws(() => parseCamt053('<Document><BkToCstmrStmt><Stmt></Document>', 'x'), /malformed XML/);
  assert.throws(() => parseCamt053('<Document><Other/></Document>', 'x'), /no BkToCstmrStmt/);
  assert.throws(() => parseCamt053(XML.replace('<CdtDbtInd>DBIT</CdtDbtInd><RvslInd>true', '<CdtDbtInd>XX</CdtDbtInd><RvslInd>true'), 'x'), /CdtDbtInd/);
  assert.throws(() => parseCamt053(XML.replace('1234.56', '1234.567'), 'x'), /more than 2 decimals/);
});

test('camt053: re-importing the same (Stmt/Id, ElctrncSeqNb) is a no-op', () => {
  const reg = new StatementRegistry();
  const [st] = parseCamt053(XML, 'bank-a');
  assert.equal(reg.accept(st), true);
  assert.equal(reg.accept(parseCamt053(XML, 'bank-a')[0]), false);
  const state = emptyState();
  const s1 = ingestInto(state, '2026-08-10', { platform: [], chain: [], statements: [st] });
  const s2 = ingestInto(state, '2026-08-10', { platform: [], chain: [], statements: parseCamt053(XML, 'bank-a') });
  assert.equal(s1.bankLines, 2);
  assert.equal(s2.bankLines, 0);
  assert.equal(s2.statementsSkipped, 1);
  assert.equal(Object.keys(state.bank).length, 2);
  assert.equal(state.balances.length, 2);
});

test('camt053: a seed statement parses and its balances reconcile with its entries', () => {
  const [st] = readCamtFile(join(SEED_DIR, 'bank-a', '2026-08-18.xml'), 'bank-a');
  const open = st.balances.find((b) => b.type === 'OPBD')!.amount;
  const close = st.balances.find((b) => b.type === 'CLBD')!.amount;
  const net = st.lines.reduce((a, l) => a + (l.direction === 'credit' ? l.amount : -l.amount), 0n);
  assert.equal(open + net, close);
  assert.ok(st.lines.some((l) => l.narrative.startsWith('OFFICE RENT') && l.amount === 341250n));
});
