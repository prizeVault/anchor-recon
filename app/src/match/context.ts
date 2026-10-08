// Everything the matcher needs besides the state: configuration files, the
// business calendar, the customer name export, the travel-rule log and the
// AI provider.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BusinessCalendar } from '../core/dates.js';
import { parseCsvLine } from '../ingest/csvBank.js';
import { nameTokens } from '../ingest/normalise.js';
import type { AiProvider } from '../ai/provider.js';
import type { FeeSchedule, SafeguardingConfig } from '../types.js';
import { type Tolerances, tolerancesFrom } from './tolerance.js';

export interface Customer {
  id: string;
  name: string;
  tokens: string[];
}

export interface ReconContext {
  fees: FeeSchedule;
  tol: Tolerances;
  sg: SafeguardingConfig;
  cal: BusinessCalendar;
  customers: Map<string, Customer>;
  travelLog: Set<string>;
  provider: AiProvider;
}

export function parseCustomers(csv: string): Map<string, Customer> {
  const rows = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(rows[0], ',');
  const iId = header.indexOf('customer_id');
  const iName = header.indexOf('full_name');
  const out = new Map<string, Customer>();
  for (const r of rows.slice(1)) {
    const f = parseCsvLine(r, ',');
    out.set(f[iId], { id: f[iId], name: f[iName], tokens: nameTokens(f[iName]) });
  }
  return out;
}

export function parseTravelLog(csv: string): Set<string> {
  const rows = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(rows[0], ',');
  const i = header.indexOf('envelope_ref');
  return new Set(rows.slice(1).map((r) => parseCsvLine(r, ',')[i].trim()));
}

export function loadContext(seedDir: string, provider: AiProvider): ReconContext {
  const fees = JSON.parse(readFileSync(join(seedDir, 'fee-schedule.json'), 'utf8')) as FeeSchedule;
  const sg = JSON.parse(readFileSync(join(seedDir, 'safeguarding.json'), 'utf8')) as SafeguardingConfig;
  const customers = existsSync(join(seedDir, 'customers.csv')) ? parseCustomers(readFileSync(join(seedDir, 'customers.csv'), 'utf8')) : new Map();
  const travelLog = existsSync(join(seedDir, 'travel-rule-log.csv')) ? parseTravelLog(readFileSync(join(seedDir, 'travel-rule-log.csv'), 'utf8')) : new Set<string>();
  return { fees, tol: tolerancesFrom(fees), sg, cal: new BusinessCalendar(sg.holidays), customers, travelLog, provider };
}
