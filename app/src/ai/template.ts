// Deterministic report templates. Every number printed comes from the
// figures object, so the numbers guard always passes for template output.

import { formatMoney } from '../core/money.js';

type F = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const eur = (cents: string | undefined) => (cents === undefined ? 'n/a' : formatMoney(BigInt(cents), 2));

function table(rows: [string, string | number][]): string {
  return ['| Item | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

function byType(obj: Record<string, number> | undefined): string {
  const entries = Object.entries(obj ?? {}).filter(([, n]) => n > 0);
  if (!entries.length) return '_none_';
  return entries.map(([t, n]) => `- ${t}: ${n}`).join('\n');
}

export function renderDaily(f: F): string {
  const sg = f.safeguarding ?? {};
  const c = f.counts ?? {};
  const out: string[] = [];
  out.push(`# Daily safeguarding reconciliation, ${f.day}`);
  out.push('');
  out.push(`${f.anchor} (${f.currency}). Prepared from computed figures for sign-off by a named person. Regulatory mapping is a draft, not legal advice.`);
  out.push('');
  out.push('## Records');
  out.push(
    table([
      ['Platform transactions in export', c.platform_txs],
      ['Chain operations', c.chain_ops],
      ['Bank lines', c.bank_lines],
      ['Matched groups', c.matched_groups],
      ['by rule', c.matched_rule],
      ['by accepted heuristic proposal', c.matched_heuristic],
      ['by accepted LLM proposal', c.matched_llm],
      ['by analyst', c.matched_analyst],
    ]),
  );
  out.push('');
  out.push('## Safeguarding (internal reconciliation)');
  out.push(
    table([
      ['Requirement', eur(sg.requirement)],
      ['Resource (designated accounts, CLBD)', sg.blocked ? 'blocked: statement missing' : eur(sg.resource)],
      ['Resource source', sg.resourceSource ?? 'n/a'],
      ['Shortfall', eur(sg.shortfall)],
      ['Excess', eur(sg.excess)],
      ['Top-up required today', eur(sg.topUpRequired)],
    ]),
  );
  out.push('');
  out.push('## External reconciliation');
  for (const x of sg.external ?? []) {
    out.push(`- ${x.account}: internal record ${eur(x.internal)}, bank CLBD ${eur(x.bank)}, difference ${eur(x.difference)}`);
  }
  if (!(sg.external ?? []).length) out.push('_no designated account statement_');
  out.push('');
  out.push('## Exceptions');
  out.push(`New today: ${f.exceptions?.totals?.new ?? 0}. Open at cut-off: ${f.exceptions?.totals?.open ?? 0}. Closed today: ${f.exceptions?.totals?.closed ?? 0}.`);
  out.push('');
  out.push('New by type:');
  out.push(byType(f.exceptions?.new));
  out.push('');
  out.push('Open by type:');
  out.push(byType(f.exceptions?.open));
  out.push('');
  out.push('## Non-rule matches (listed for review)');
  const nr = (f.nonRuleMatches ?? []) as F[];
  if (!nr.length) out.push('_none_');
  for (const m of nr) out.push(`- ${m.groupId}: ${m.kind} for ${m.platformId}, score ${m.score}, ${m.method}, accepted by ${m.decidedBy}`);
  out.push('');
  if ((f.sample ?? []).length) {
    out.push(`High-band re-check sample: ${(f.sample as string[]).join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}

export function renderMonthly(f: F): string {
  const out: string[] = [];
  out.push(`# Monthly safeguarding return, ${f.month} (REP027-style draft)`);
  out.push('');
  out.push(`${f.anchor} (${f.currency}). REP027 field list not verified against the FCA's published return; this is a draft from computed figures, not legal advice.`);
  out.push('');
  out.push(
    table([
      ['Reconciliation days expected', f.expectedDays],
      ['Attested on time', f.onTime],
      ['Attested late', f.late],
      ['Gaps flagged', f.gaps],
      ['Restatements', f.restatements],
      ['Days with a shortfall', f.shortfallDays],
      ['Maximum shortfall', eur(f.maxShortfall)],
      ['Total shortfall (sum of daily figures)', eur(f.totalShortfall)],
      ['Maximum requirement', eur(f.maxRequirement)],
    ]),
  );
  out.push('');
  out.push('## Exceptions raised in the month, by type');
  out.push(byType(f.exceptionsByType));
  out.push('');
  out.push(`Open at month end: ${f.openAtEnd}.`);
  out.push('');
  return out.join('\n');
}

export function renderTemplate(kind: 'daily' | 'monthly', figures: F): string {
  return kind === 'daily' ? renderDaily(figures) : renderMonthly(figures);
}
