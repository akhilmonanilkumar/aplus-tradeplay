/**
 * CFD setups board, the pure half: where each paper setup stands against the live price, and how much
 * its strategy has earned so far (paper record since the League restart, the walk-forward backtest and the
 * League stage), so the board can rank today's setups by the strategies that are actually winning.
 */

export type SetupStatus = "enter" | "waiting" | "in_trade" | "won" | "failed";
export type FailKind = "stopped" | "expired" | "ran_away";

export interface SetupInput {
  side: "long" | "short"; entry: number; stop: number; target: number;
  createdAt: number; market: boolean; outcome: string; filledAt: number | null; closedAt: number | null; resultR: number | null;
}

export interface SetupState {
  status: SetupStatus; fail: FailKind | null;
  /** Price distance to the entry in R (positive: not reached yet). */
  toEntryR: number | null;
  /** Open result in R at the live price, once filled. */
  r: number | null;
  /** Filled, but price is still close enough to the entry to take it late. */
  lateOk: boolean;
  /** When an unfilled limit order is dropped (the ledger's 12-bar expiry). */
  expiresAt: number | null;
  reason: string;
}

/** Within this many R of the entry counts as "at the entry" (place it now / still takeable). */
export const NEAR_R = 0.15;
export const LATE_R = 0.3;
export const EXPIRY_BARS = 12;
/** A filled setup stays takeable by hand for this long, while price is within LATE_R of the entry. */
export const LATE_MS = 45 * 60_000;

const FAIL_TEXT: Record<FailKind, string> = {
  stopped: "Stopped out", expired: "No fill before the order expired", ran_away: "Target hit before the entry filled",
};

export function setupState(s: SetupInput, price: number | null, tfMs: number, now = Date.now()): SetupState {
  const risk = Math.abs(s.entry - s.stop) || 1;
  const dir = s.side === "long" ? 1 : -1;
  const base = { toEntryR: null, r: null, lateOk: false, expiresAt: null } as const;
  if (s.outcome === "win") return { ...base, status: "won", fail: null, r: s.resultR, reason: "Target reached" };
  if (s.outcome === "loss") return { ...base, status: "failed", fail: "stopped", r: s.resultR ?? -1, reason: FAIL_TEXT.stopped };
  if (s.outcome === "expired" || s.outcome === "ran_away") {
    const fail: FailKind = s.outcome === "expired" ? "expired" : "ran_away";
    return { ...base, status: "failed", fail, reason: FAIL_TEXT[fail] };
  }
  const filled = s.outcome === "filled" || s.market;
  if (filled) {
    const r = price === null ? null : (dir * (price - s.entry)) / risk;
    // Recently filled and price still near the entry: it can still be taken by hand.
    const lateOk = r !== null && Math.abs(r) <= LATE_R && now - (s.filledAt ?? s.createdAt) <= LATE_MS;
    return { ...base, status: lateOk ? "enter" : "in_trade", fail: null, r: r === null ? null : round(r), lateOk, reason: lateOk ? "Filled on paper; price is still near the entry" : "Running on paper" };
  }
  // Pending limit: distance to the fill, and the expiry clock.
  const expiresAt = s.createdAt + EXPIRY_BARS * tfMs;
  const toEntryR = price === null ? null : round((dir * (price - s.entry)) / risk);
  const near = toEntryR !== null && toEntryR <= NEAR_R;
  return { ...base, status: near ? "enter" : "waiting", fail: null, toEntryR, expiresAt, reason: near ? "Price is at the entry" : "Waiting for the retrace to the entry" };
}

export interface EdgeInput {
  stage: string | null;
  paper: { n: number; expectancy: number; profitFactor: number | null; winRate: number; lowerBound: number } | null;
  backtest: { trades: number; avgR?: number | null; profitFactor: number | null; pass?: boolean } | null;
}

export interface Edge {
  score: number;
  /** A strategy with a positive record: paper (10+ trades) or a passing backtest. */
  winning: boolean;
  label: string;
}

const STAGE_BONUS: Record<string, number> = { live: 0.3, live_small: 0.2, candidate: 0.1, paper: 0, benched: -0.3 };

/**
 * Edge score in R per trade, shrunk towards zero on small samples so a lucky three-trade run cannot
 * outrank a strategy with fifty trades behind it. Paper outweighs the backtest when both exist.
 */
export function edgeScore(e: EdgeInput): Edge {
  const p = e.paper && e.paper.n > 0 ? (e.paper.expectancy * e.paper.n) / (e.paper.n + 15) : null;
  const avg = e.backtest?.avgR ?? null;
  const b = e.backtest && avg !== null && e.backtest.trades > 0 ? (avg * e.backtest.trades) / (e.backtest.trades + 30) : null;
  const core = p !== null && b !== null ? 0.6 * p + 0.4 * b : p ?? b ?? 0;
  const score = round(core + (STAGE_BONUS[e.stage ?? "paper"] ?? 0), 3);
  const winning = (!!e.paper && e.paper.n >= 10 && e.paper.expectancy > 0 && e.paper.lowerBound > -0.2) || (!!e.backtest?.pass && (avg ?? 0) > 0);
  const parts = [
    e.paper && e.paper.n ? `Paper ${signedR(e.paper.expectancy)} · ${e.paper.n} trade${e.paper.n === 1 ? "" : "s"}${e.paper.profitFactor !== null ? ` · PF ${e.paper.profitFactor.toFixed(2)}` : ""}` : "No paper trades yet",
    e.backtest && avg !== null ? `Backtest ${signedR(avg)} · ${e.backtest.trades}` : "",
  ].filter(Boolean);
  return { score, winning, label: parts.join(" · ") };
}

const ORDER: Record<SetupStatus, number> = { enter: 0, waiting: 1, in_trade: 2, won: 3, failed: 4 };

/** Actionable first (at the entry, then waiting, then running), best edge first inside each group. */
export function rankSetups<T extends { status: SetupStatus; edge: Edge; createdAt: string | number }>(xs: T[]): (T & { rank: number | null })[] {
  const sorted = [...xs].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.edge.score - a.edge.score || +new Date(b.createdAt) - +new Date(a.createdAt));
  let n = 0;
  return sorted.map((x) => ({ ...x, rank: x.status === "enter" || x.status === "waiting" ? ++n : null }));
}

function round(x: number, d = 2) { return Number(x.toFixed(d)); }
function signedR(x: number) { return `${x > 0 ? "+" : ""}${x.toFixed(2)}R`; }
