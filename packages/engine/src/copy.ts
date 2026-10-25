import { sizeCfd, sizePerp, type CfdSpec, type PerpSpec } from './sizing.js';

export type CopyPolicy = 'AUTO' | 'CONFIRM' | 'MANUAL' | 'PAPER' | 'BLOCKED';
export type CopyAction = 'SEND' | 'CONFIRM' | 'MANUAL' | 'PAPER' | 'BLOCK' | 'SKIP';

export interface CopyAccount {
  id: string;
  name: string;
  policy: CopyPolicy;
  balance: number;
  riskPct: number;
  instrument: { kind: 'cfd'; spec: CfdSpec } | { kind: 'perp'; spec: PerpSpec; leverage: number };
  /** Money left before the firm's / account's daily loss limit. */
  dailyLossRoom?: number;
  /** Money left before the overall loss floor. */
  maxLossRoom?: number;
  newsBlocked?: boolean;
  /** Fraction of remaining room one stop may use (default 0.5). */
  roomBuffer?: number;
}

export interface CopyOrder {
  entry: number;
  stop: number;
  target?: number;
}

export interface CopyDecision {
  accountId: string;
  action: CopyAction;
  size: number;
  riskAmount: number;
  reasons: string[];
  shrunk: boolean;
}

/**
 * Size one master order for every copy account and run the pre-trade guard.
 * The guard can shrink or block an order, never enlarge it.
 */
export function planCopies(order: CopyOrder, accounts: readonly CopyAccount[]): CopyDecision[] {
  return accounts.map((a) => {
    const reasons: string[] = [];
    if (a.policy === 'BLOCKED') return { accountId: a.id, action: 'BLOCK', size: 0, riskAmount: 0, reasons: ['copy blocked by policy'], shrunk: false };
    if (a.newsBlocked) return { accountId: a.id, action: 'BLOCK', size: 0, riskAmount: 0, reasons: ['news window'], shrunk: false };

    const buffer = a.roomBuffer ?? 0.5;
    const budget = (a.balance * a.riskPct) / 100;
    const caps = [budget];
    if (a.dailyLossRoom !== undefined) caps.push(a.dailyLossRoom * buffer);
    if (a.maxLossRoom !== undefined) caps.push(a.maxLossRoom * buffer);
    const allowed = Math.max(0, Math.min(...caps));
    const shrunk = allowed < budget - 1e-9;
    if (shrunk) reasons.push(`risk cut from ${budget.toFixed(2)} to ${allowed.toFixed(2)} to protect loss limits`);
    const effPct = (allowed / a.balance) * 100;

    let size = 0, risk = 0, below = false;
    if (effPct > 0) {
      if (a.instrument.kind === 'cfd') {
        const s = sizeCfd({ balance: a.balance, riskPct: effPct, entry: order.entry, stop: order.stop, spec: a.instrument.spec });
        size = s.lots; risk = s.riskAmount; below = s.belowMinimum;
      } else {
        const s = sizePerp({ balance: a.balance, riskPct: effPct, entry: order.entry, stop: order.stop, target: order.target, leverage: a.instrument.leverage, spec: a.instrument.spec });
        size = s.qty; risk = s.lossAtStop; below = s.belowMinimum;
        if (!s.liquidationBeyondStop && s.qty > 0) return { accountId: a.id, action: 'BLOCK', size: 0, riskAmount: 0, reasons: ['liquidation price inside stop'], shrunk };
      }
    } else below = true;

    if (below || size === 0) return { accountId: a.id, action: 'BLOCK', size: 0, riskAmount: 0, reasons: [...reasons, 'below minimum size after rounding'], shrunk };

    const action: CopyAction = a.policy === 'AUTO' ? 'SEND' : a.policy === 'CONFIRM' ? 'CONFIRM' : a.policy === 'MANUAL' ? 'MANUAL' : 'PAPER';
    return { accountId: a.id, action, size, riskAmount: risk, reasons, shrunk };
  });
}

/** Deterministic idempotency key so a retried fan-out never doubles an order. */
export function clientOrderId(signalId: string, accountId: string): string {
  let h = 2166136261;
  const s = `${signalId}:${accountId}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `aplus-${(h >>> 0).toString(36)}-${signalId.slice(0, 8)}`;
}
