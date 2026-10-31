/**
 * Risk gate for real-money orders (Delta Exchange). Pure: every input is passed in, so the same rules
 * run in the autopilot, the dry run and the tests. An order is planned only when every rule passes;
 * otherwise the reasons say why. Hard caps bound every setting: the policy can be tightened, never
 * loosened past them.
 */

export interface LivePolicy {
  /** Risk per trade, % of equity. */
  riskPct: number;
  /** Stop new orders for the IST day at this loss, % of start-of-day equity. */
  dailyLossPct: number;
  maxLossesPerDay: number;
  maxTradesPerDay: number;
  /** All open stops hit together, % of equity. */
  maxOpenRiskPct: number;
  maxPositions: number;
  /** Halt live trading at this drawdown from the equity peak, %. */
  maxDrawdownPct: number;
  maxLeverage: number;
  minRR: number;
  /** Skip when price has moved this far (in R) from the planned entry. */
  maxEntryDriftR: number;
  signalTtlMin: number;
  newsBlockMin: number;
  cancelAfterMin: number;
  apiErrorLimit: number;
  apiErrorWindowMin: number;
  haltMinutes: number;
  /** Size as if the account held at most this much (USD); null = the whole balance. */
  capitalCap: number | null;
}

export const DEFAULT_POLICY: LivePolicy = {
  riskPct: 0.5, dailyLossPct: 2, maxLossesPerDay: 2, maxTradesPerDay: 4, maxOpenRiskPct: 1.5, maxPositions: 2,
  maxDrawdownPct: 8, maxLeverage: 5, minRR: 1.5, maxEntryDriftR: 0.25, signalTtlMin: 10, newsBlockMin: 15,
  cancelAfterMin: 60, apiErrorLimit: 3, apiErrorWindowMin: 30, haltMinutes: 30, capitalCap: null,
};

/** Bounds no setting may cross: [min, max]. */
export const HARD_CAPS: Partial<Record<keyof LivePolicy, [number, number]>> = {
  riskPct: [0.05, 1], dailyLossPct: [0.25, 3], maxLossesPerDay: [1, 3], maxTradesPerDay: [1, 6], maxOpenRiskPct: [0.1, 2],
  maxPositions: [1, 3], maxDrawdownPct: [1, 10], maxLeverage: [1, 10], minRR: [1, 10], maxEntryDriftR: [0, 0.5],
  signalTtlMin: [1, 30], newsBlockMin: [5, 60], cancelAfterMin: [5, 240], apiErrorLimit: [1, 10], apiErrorWindowMin: [5, 120], haltMinutes: [5, 1440],
};

export function policyFrom(raw: unknown): LivePolicy {
  const p = { ...DEFAULT_POLICY, ...((raw ?? {}) as Partial<LivePolicy>) };
  for (const [k, [lo, hi]] of Object.entries(HARD_CAPS) as [keyof LivePolicy, [number, number]][]) {
    const v = Number(p[k]);
    (p as Record<string, unknown>)[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_POLICY[k];
  }
  p.capitalCap = p.capitalCap === null || p.capitalCap === undefined || !(Number(p.capitalCap) > 0) ? null : Number(p.capitalCap);
  return p;
}

export interface ProductSpec { symbol: string; productId: number; contractValue: number; tick: number; takerFee: number }

export interface RiskInput {
  policy: LivePolicy;
  now: number;
  equity: number;
  startOfDayEquity: number;
  peakEquity: number;
  /** Realised P&L today (IST), USD. */
  todayPnl: number;
  todayLosses: number;
  todayTrades: number;
  /** Open positions and working entries: symbol and the USD lost if every stop is hit. */
  open: { symbol: string; riskUsd: number }[];
  killSwitch: boolean;
  haltedUntil: number | null;
  newsBlocked: boolean;
  signal: { createdAt: number; side: "long" | "short"; entry: number; stop: number; target: number };
  /** Our feed's price and the venue's mid when the order is planned (levels shift by the difference). */
  ourPrice: number;
  venueMid: number;
  product: ProductSpec;
}

export interface OrderPlan {
  side: "buy" | "sell"; contracts: number; limitPrice: number; stop: number; target: number;
  riskUsd: number; notional: number; leverage: number; rr: number; basis: number; feesUsd: number;
}

const toTick = (x: number, tick: number, mode: "round" | "floor" | "ceil") => {
  const n = x / tick;
  const k = mode === "round" ? Math.round(n) : mode === "floor" ? Math.floor(n + 1e-9) : Math.ceil(n - 1e-9);
  const d = Math.max(0, -Math.floor(Math.log10(tick)));
  return Number((k * tick).toFixed(d));
};

/** Plan a bracketed limit order for a live signal, or say why not. */
export function planLiveOrder(i: RiskInput): { ok: true; plan: OrderPlan; reasons: [] } | { ok: false; reasons: string[]; plan?: OrderPlan } {
  const p = i.policy, reasons: string[] = [];
  const long = i.signal.side === "long";

  // Account-level stops first: any of these blocks every order.
  if (i.killSwitch) reasons.push("kill switch is on");
  if (i.haltedUntil && i.now < i.haltedUntil) reasons.push(`live trading halted until ${new Date(i.haltedUntil).toISOString().slice(11, 16)} UTC`);
  if (i.peakEquity > 0 && ((i.peakEquity - i.equity) / i.peakEquity) * 100 >= p.maxDrawdownPct) reasons.push(`drawdown ${(((i.peakEquity - i.equity) / i.peakEquity) * 100).toFixed(2)}% ≥ ${p.maxDrawdownPct}% from peak`);
  const dayLossCap = (i.startOfDayEquity * p.dailyLossPct) / 100;
  if (-i.todayPnl >= dayLossCap) reasons.push(`daily loss ${i.todayPnl.toFixed(2)} reached the ${p.dailyLossPct}% cap`);
  if (i.todayLosses >= p.maxLossesPerDay) reasons.push(`${i.todayLosses} losses today (stop after ${p.maxLossesPerDay})`);
  if (i.todayTrades >= p.maxTradesPerDay) reasons.push(`${i.todayTrades} trades today (max ${p.maxTradesPerDay})`);
  if (i.open.some((o) => o.symbol === i.product.symbol)) reasons.push(`already in ${i.product.symbol}`);
  if (i.open.length >= p.maxPositions) reasons.push(`${i.open.length} positions open (max ${p.maxPositions})`);
  if (i.newsBlocked) reasons.push(`high-impact news within ${p.newsBlockMin} min`);
  if (i.now - i.signal.createdAt > p.signalTtlMin * 60_000) reasons.push(`signal is ${Math.round((i.now - i.signal.createdAt) / 60_000)} min old (max ${p.signalTtlMin})`);
  if (!(i.equity > 0)) reasons.push("no account equity");

  // Levels on the venue: shift by the basis, keep distances; stop and target rounded conservatively.
  const basis = i.venueMid - i.ourPrice;
  const t = i.product.tick;
  const entry = toTick(i.signal.entry + basis, t, "round");
  const stop = toTick(i.signal.stop + basis, t, long ? "floor" : "ceil");
  const target = toTick(i.signal.target + basis, t, long ? "floor" : "ceil");
  const dist = Math.abs(entry - stop);
  if (!(dist > 0) || (long ? !(stop < entry && target > entry) : !(stop > entry && target < entry))) {
    reasons.push("levels are not a valid bracket");
    return { ok: false, reasons };
  }
  const rr = Math.abs(target - entry) / dist;
  if (rr < p.minRR) reasons.push(`${rr.toFixed(2)}R to target < ${p.minRR}R`);
  // No chasing: price must still be between the stop and entry + drift.
  const drift = ((long ? 1 : -1) * (i.venueMid - entry)) / dist;
  if (drift > p.maxEntryDriftR) reasons.push(`price ran ${drift.toFixed(2)}R past the entry (max ${p.maxEntryDriftR}R)`);
  if (long ? i.venueMid <= stop : i.venueMid >= stop) reasons.push("price is already through the stop");

  // Size: risk budget, bounded by what is left of the daily cap and of the open-risk cap.
  const eq = p.capitalCap ? Math.min(i.equity, p.capitalCap) : i.equity;
  const openRisk = i.open.reduce((s, o) => s + o.riskUsd, 0);
  const budget = Math.min((eq * p.riskPct) / 100, Math.max(0, dayLossCap + Math.min(0, i.todayPnl)), Math.max(0, (eq * p.maxOpenRiskPct) / 100 - openRisk));
  const cv = i.product.contractValue;
  const feePerContract = i.product.takerFee * cv * (entry + stop);
  const lossPerContract = dist * cv + feePerContract;
  let contracts = Math.floor(budget / lossPerContract + 1e-9);
  const maxByLev = Math.floor((p.maxLeverage * eq) / (cv * entry) + 1e-9);
  contracts = Math.min(contracts, maxByLev);
  if (contracts < 1) reasons.push(`risk budget $${budget.toFixed(2)} is below one contract ($${lossPerContract.toFixed(2)} at the stop)`);
  const notional = contracts * cv * entry;
  const plan: OrderPlan = {
    side: long ? "buy" : "sell", contracts, limitPrice: entry, stop, target, riskUsd: Number((contracts * lossPerContract).toFixed(2)),
    notional: Number(notional.toFixed(2)), leverage: eq > 0 ? Number((notional / eq).toFixed(2)) : 0, rr: Number(rr.toFixed(2)),
    basis: Number(basis.toFixed(4)), feesUsd: Number((contracts * feePerContract).toFixed(2)),
  };
  return reasons.length ? { ok: false, reasons, plan } : { ok: true, plan, reasons: [] };
}

/** Instruments a promoted strategy may trade on Delta, by our market id. */
export const DELTA_SYMBOL: Record<string, string> = {
  "BTCUSDT.P": "BTCUSD", BTCUSD: "BTCUSD", "BTCUSD.SPOT": "BTCUSD",
  XAUUSD: "XAUTUSD", "XAUUSDT.P": "XAUTUSD",
};
