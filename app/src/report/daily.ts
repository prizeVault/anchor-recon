// Daily report: draft from figures via the provider (numbers-guarded), kept
// watermarked DRAFT until `--approve <name>` stamps the name, time and the
// sha256 of figures.json. report_hash = sha256(approved markdown).

import { jcs, sha256Hex } from '../core/hash.js';
import type { AiProvider } from '../ai/provider.js';
import { guardReport } from '../ai/guard.js';
import { renderTemplate } from '../ai/template.js';
import type { ReportState } from '../store/store.js';

export const DRAFT_MARK = '> **DRAFT** - not approved. Figures computed deterministically; narrative drafted for sign-off.';

export function figuresHash(figures: unknown): string {
  return sha256Hex(jcs(figures));
}

export async function draftReport(provider: AiProvider, kind: 'daily' | 'monthly', key: string, figures: Record<string, unknown>): Promise<ReportState & { fellBack: boolean }> {
  const r = await provider.draftReport({ kind, figures });
  let md = r.markdown;
  let fellBack = r.fellBack;
  let prov = r.provider;
  const g = guardReport(md, figures);
  if (!g.ok) {
    md = renderTemplate(kind, figures);
    fellBack = true;
    prov = 'template';
  }
  return { day: key, kind, markdown: `${DRAFT_MARK}\n\n${md}`, provider: prov, figuresHash: figuresHash(figures), fellBack };
}

export function approveReport(r: ReportState, name: string, at: string): ReportState {
  if (!name.trim()) throw new Error('approver name required');
  const body = r.markdown.startsWith(DRAFT_MARK) ? r.markdown.slice(DRAFT_MARK.length).trimStart() : r.markdown;
  const stamp = `> **APPROVED** by ${name} at ${at}. figures.json sha256 ${r.figuresHash}.`;
  return { ...r, markdown: `${stamp}\n\n${body}`, approvedBy: name, approvedAt: at };
}

export function reportHash(r: ReportState): string {
  if (!r.approvedBy) throw new Error(`report ${r.day} is not approved`);
  return sha256Hex(r.markdown);
}
