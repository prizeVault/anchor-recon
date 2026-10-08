// RPC fallback: SAC `transfer` events through getEvents, for recent days only
// (RPC retains events for about 7 days). Classic payments emit these events
// only where the node enables CAP-67 emission, so this is best-effort and never
// the primary source. Behind the ChainSource interface.

import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import type { ChainOp } from '../types.js';
import type { ChainSource } from './horizon.js';

export const RPC_RETENTION_DAYS = 7;

export interface TransferEvent {
  id: string;
  txHash: string;
  ledgerClosedAt: string;
  contractId: string;
  topics: string[]; // base64 XDR ScVal
  value: string; // base64 XDR ScVal
}

/** Decodes a SAC transfer event: topics ["transfer", from, to, asset], value amount (i128). */
export function decodeTransfer(ev: TransferEvent, anchorAccounts: string[], assetByContract: Record<string, string>): ChainOp | undefined {
  const topics = ev.topics.map((t) => scValToNative(xdr.ScVal.fromXDR(t, 'base64')));
  if (topics[0] !== 'transfer') return undefined;
  const from = String(topics[1]);
  const to = String(topics[2]);
  const amt = scValToNative(xdr.ScVal.fromXDR(ev.value, 'base64'));
  const amount = typeof amt === 'bigint' ? amt : BigInt((amt as { amount?: bigint }).amount ?? 0);
  const account = anchorAccounts.find((a) => a === to || a === from) ?? '';
  return {
    opId: `evt:${ev.id}`,
    txHash: ev.txHash,
    ledgerCloseTime: ev.ledgerClosedAt,
    type: 'payment',
    from,
    to,
    asset: assetByContract[ev.contractId] ?? String(topics[3] ?? 'UNKNOWN').split(':')[0],
    amount,
    account,
    direction: anchorAccounts.includes(to) ? 'in' : 'out',
    day: ev.ledgerClosedAt.slice(0, 10),
  };
}

export function withinRetention(day: string, today: string): boolean {
  const ms = Date.parse(today) - Date.parse(day);
  return ms >= 0 && ms <= RPC_RETENTION_DAYS * 86_400_000;
}

export class RpcEventsSource implements ChainSource {
  readonly name = 'rpc-events';
  constructor(
    private readonly rpcUrl: string,
    private readonly contracts: string[],
    private readonly accounts: string[],
    private readonly assetByContract: Record<string, string>,
  ) {}
  async operations(day: string): Promise<ChainOp[]> {
    if (!withinRetention(day, new Date().toISOString().slice(0, 10))) {
      throw new Error(`RPC events are retained for ~${RPC_RETENTION_DAYS} days; ${day} is outside the window`);
    }
    const server = new rpc.Server(this.rpcUrl);
    const latest = await server.getLatestLedger();
    const res = await server.getEvents({
      startLedger: Math.max(1, latest.sequence - 17_280 * RPC_RETENTION_DAYS),
      filters: [{ type: 'contract', contractIds: this.contracts, topics: [[xdr.ScVal.scvSymbol('transfer').toXDR('base64'), '*', '*', '*']] }],
      limit: 1000,
    });
    return res.events
      .map((e) =>
        decodeTransfer(
          {
            id: e.id,
            txHash: e.txHash,
            ledgerClosedAt: e.ledgerClosedAt,
            contractId: e.contractId?.toString() ?? '',
            topics: e.topic.map((t) => t.toXDR('base64')),
            value: e.value.toXDR('base64'),
          },
          this.accounts,
          this.assetByContract,
        ),
      )
      .filter((o): o is ChainOp => !!o && o.day === day);
  }
}
