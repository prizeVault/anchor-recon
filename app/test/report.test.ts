import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { guardReport } from '../src/ai/guard.js';
import { renderTemplate } from '../src/ai/template.js';
import { LlmProvider, type MessagesClient } from '../src/ai/llm.js';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import { approveReport, draftReport, DRAFT_MARK, figuresHash, reportHash } from '../src/report/daily.js';
import { monthlyFigures, type DailyFigures } from '../src/report/figures.js';
import { emptyState } from '../src/store/store.js';

const figures = {
  kind: 'daily',
  day: '2026-08-18',
  anchor: 'SIM ANCHOR EMI (simulated)',
  currency: 'EUR',
  counts: { platform_txs: 21, chain_ops: 19, bank_lines: 30, matched_groups: 42, matched_rule: 40, matched_heuristic: 2, matched_llm: 0, matched_analyst: 0, exceptions_new: 1, exceptions_open: 3, exceptions_closed: 0, travel_rule_missing: 0 },
  exceptions: { new: { NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING: 1 }, open: { NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING: 1, STALE_PENDING: 2 }, closed: {}, aged: 0, totals: { new: 1, open: 3, closed: 0 } },
  safeguarding: { requirement: '1841250', requirementLines: 9, resource: '1500000', resourceSource: 'statement', shortfall: '341250', excess: '0', topUpRequired: '341250', blocked: false, external: [{ account: 'bank-a', internal: '1500000', bank: '1500000', difference: '0' }] },
  nonRuleMatches: [{ groupId: 'G-1', platformId: 'p1', kind: 'fee_diff', method: 'heuristic', decidedBy: 'A', score: '0.950' }],
  proposals: { high: 2, review: 0, pending: 0 },
  sample: ['P-1'],
  formatted: {},
};

function fake(text: string): MessagesClient {
  return { messages: { create: async () => ({ content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn' }) as unknown as Anthropic.Message } };
}

test('report: the template passes the numbers guard and prints the shortfall', () => {
  const md = renderTemplate('daily', figures);
  assert.ok(guardReport(md, figures).ok, guardReport(md, figures).errors.join(';'));
  assert.match(md, /Shortfall \| 3412\.50/);
  assert.match(md, /Top-up required today \| 3412\.50/);
});

test('report: the numbers guard rejects an invented figure', () => {
  const md = renderTemplate('daily', figures) + '\nThe shortfall was really 3500.00 EUR on 2026-08-19.';
  const g = guardReport(md, figures);
  assert.equal(g.ok, false);
  assert.ok(g.errors.some((e) => e.includes('3500.00')));
  assert.ok(g.errors.some((e) => e.includes('2026-08-19')));
});

test('report: an LLM draft with an invented number falls back to the template', async () => {
  const llm = new LlmProvider({ client: fake('# Report\nShortfall 3412.50 EUR, about 12 percent of volume.') });
  const r = await draftReport(llm, 'daily', '2026-08-18', figures);
  assert.equal(r.provider, 'template');
  assert.equal(r.fellBack, true);
  assert.ok(llm.log.some((l) => l.includes('numbers guard')));
  assert.ok(r.markdown.startsWith(DRAFT_MARK));
  const ok = new LlmProvider({ client: fake('# Daily\nShortfall 3412.50 EUR; requirement 18412.50 EUR; 42 matched groups.') });
  const r2 = await draftReport(ok, 'daily', '2026-08-18', figures);
  assert.equal(r2.provider, 'llm');
});

test('report: DRAFT until approved; approval stamps name, time and figures hash', async () => {
  const r = await draftReport(new HeuristicProvider(), 'daily', '2026-08-18', figures);
  assert.ok(r.markdown.startsWith(DRAFT_MARK));
  assert.throws(() => reportHash(r), /not approved/);
  const a = approveReport(r, 'C. Compliance', '2026-08-18T17:45:00.000Z');
  assert.ok(!a.markdown.includes('**DRAFT**'));
  assert.match(a.markdown, /APPROVED\*\* by C\. Compliance at 2026-08-18T17:45:00\.000Z/);
  assert.ok(a.markdown.includes(figuresHash(figures)));
  assert.match(reportHash(a), /^[0-9a-f]{64}$/);
  assert.throws(() => approveReport(r, ' ', 'x'), /approver/);
});

test('report: monthly aggregation over registry day statuses and daily figures', () => {
  const state = emptyState();
  const f = (d: string, sf: string, req: string) => ({ safeguarding: { shortfall: sf, requirement: req } }) as unknown as DailyFigures;
  state.figures = { '2026-08-03': f('2026-08-03', '0', '1000'), '2026-08-04': f('2026-08-04', '500', '9000'), '2026-08-05': f('2026-08-05', '0', '3000') };
  state.exceptions = [{ id: 'e', type: 'SHORT_PAYOUT', day: '2026-08-04', evidenceIds: [], openedOn: '2026-08-04', status: 'open' }];
  const m = monthlyFigures(state, '2026-08', 'SIM', 'EUR', [
    { day: '2026-08-01', status: 'NotExpected', versions: 0 },
    { day: '2026-08-03', status: 'Attested', versions: 2 },
    { day: '2026-08-04', status: 'GapThenAttested', versions: 1 },
    { day: '2026-08-05', status: 'AttestedLate', versions: 1 },
    { day: '2026-08-06', status: 'NonReconDay', versions: 0 },
  ]);
  assert.equal(m.expectedDays, 3);
  assert.equal(m.onTime, 1);
  assert.equal(m.late, 2);
  assert.equal(m.gaps, 1);
  assert.equal(m.restatements, 1);
  assert.equal(m.shortfallDays, 1);
  assert.equal(m.maxShortfall, '500');
  assert.equal(m.maxRequirement, '9000');
  assert.equal(m.exceptionsByType.SHORT_PAYOUT, 1);
  assert.equal(m.openAtEnd, 1);
  const md = renderTemplate('monthly', m as unknown as Record<string, unknown>);
  assert.ok(guardReport(md, m).ok);
  assert.match(md, /REP027-style draft/);
});
