/**
 * Strategy promotion rules and candidate statistics, shared by the autopilot (which applies them) and
 * the Live page (which shows progress toward them). A candidate is one market × entry model, or one
 * session strategy, scored on its recent paper record in net R after costs.
 */

export interface PromotionRules {
  enabled: boolean;
  /** Promote automatically when a candidate clears every rule (else it is only flagged as ready). */
  autoPromote: boolean;
  /** Bench a live strategy automatically when it breaks a demotion rule. */
  autoDemote: boolean;
  /** Rolling look-back for promotion, in days. */
  windowDays: number;
  minTrades: number;
  /** Net R per trade after costs. */
  minExpectancy: number;
  minProfitFactor: number;
  /** Worst peak-to-trough run inside the window, in R. */
  maxDrawdownR: number;
  /** The last 10 resolved trades must not be net negative. */
  requireRecentPositive: boolean;
  maxLive: number;
  /** Demotion looks at the last N resolved trades. */
  demoteLastN: number;
  demoteExpectancy: number;
  demoteProfitFactor: number;
  /** Drawdown since going live, in R. */
  demoteDrawdownR: number;
  /** A benched strategy waits this many days before it can be promoted again. */
  cooldownDays: number;
  /** A waiting candidate replaces the weakest live one when its score is this many times higher. */
  swapMargin: number;
}

export const DEFAULT_RULES: PromotionRules = {
  enabled: true, autoPromote: true, autoDemote: true,
  windowDays: 30, minTrades: 20, minExpectancy: 0.15, minProfitFactor: 1.3, maxDrawdownR: 8, requireRecentPositive: true,
  maxLive: 5,
  demoteLastN: 20, demoteExpectancy: 0, demoteProfitFactor: 1.0, demoteDrawdownR: 6,
  cooldownDays: 7, swapMargin: 1.5,
};

export const rulesFrom = (raw: unknown): PromotionRules => ({ ...DEFAULT_RULES, ...((raw ?? {}) as Partial<PromotionRules>) });

/** A resolved tracked setup (win or loss with net R after costs). */
export interface ResolvedTrade { at: number; netR: number; grossR: number }

export interface CandidateStats {
  n: number; wins: number; winRate: number; netR: number; expectancy: number; profitFactor: number | null;
  maxDrawdownR: number; last10R: number; avgCostR: number; score: number; firstAt: number | null; lastAt: number | null;
}

export function statsOf(trades: ResolvedTrade[]): CandidateStats {
  const xs = [...trades].sort((a, b) => a.at - b.at);
  const n = xs.length;
  const netR = xs.reduce((s, t) => s + t.netR, 0);
  const gains = xs.filter((t) => t.netR > 0).reduce((s, t) => s + t.netR, 0);
  const losses = -xs.filter((t) => t.netR < 0).reduce((s, t) => s + t.netR, 0);
  let cum = 0, peak = 0, dd = 0;
  for (const t of xs) { cum += t.netR; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const exp = n ? netR / n : 0;
  return {
    n, wins: xs.filter((t) => t.netR > 0).length, winRate: n ? xs.filter((t) => t.netR > 0).length / n : 0,
    netR: round(netR), expectancy: round(exp, 3), profitFactor: losses > 0 ? round(gains / losses) : gains > 0 ? null : 0,
    maxDrawdownR: round(dd), last10R: round(xs.slice(-10).reduce((s, t) => s + t.netR, 0)),
    avgCostR: round(n ? xs.reduce((s, t) => s + (t.grossR - t.netR), 0) / n : 0, 3),
    // t-statistic-like: rewards both edge and sample size.
    score: round(exp * Math.sqrt(n), 3), firstAt: xs[0]?.at ?? null, lastAt: xs.at(-1)?.at ?? null,
  };
}

const round = (x: number, d = 2) => Number(x.toFixed(d));
const pf = (s: CandidateStats) => (s.profitFactor === null ? Infinity : s.profitFactor);

/** Every promotion rule with whether the window stats pass it (for the UI's progress view). */
export function promotionChecks(s: CandidateStats, r: PromotionRules) {
  return [
    { label: `≥ ${r.minTrades} trades`, ok: s.n >= r.minTrades, value: `${s.n}` },
    { label: `expectancy ≥ ${r.minExpectancy}R`, ok: s.expectancy >= r.minExpectancy, value: `${s.expectancy}R` },
    { label: `profit factor ≥ ${r.minProfitFactor}`, ok: pf(s) >= r.minProfitFactor, value: s.profitFactor === null ? "∞" : `${s.profitFactor}` },
    { label: `drawdown ≤ ${r.maxDrawdownR}R`, ok: s.maxDrawdownR <= r.maxDrawdownR, value: `${s.maxDrawdownR}R` },
    ...(r.requireRecentPositive ? [{ label: "last 10 ≥ 0R", ok: s.last10R >= 0, value: `${s.last10R}R` }] : []),
  ];
}
export const promotable = (s: CandidateStats, r: PromotionRules) => promotionChecks(s, r).every((c) => c.ok);

/** The first demotion rule a live strategy breaks, or null. `recent` = last N trades; `live` = since going live. */
export function demotionReason(recent: CandidateStats, live: CandidateStats, r: PromotionRules): string | null {
  if (recent.n >= Math.min(10, r.demoteLastN)) {
    if (recent.expectancy < r.demoteExpectancy) return `last ${recent.n} trades expectancy ${recent.expectancy}R < ${r.demoteExpectancy}R`;
    if (pf(recent) < r.demoteProfitFactor) return `last ${recent.n} trades profit factor ${recent.profitFactor} < ${r.demoteProfitFactor}`;
  }
  if (live.maxDrawdownR >= r.demoteDrawdownR) return `drawdown since live ${live.maxDrawdownR}R ≥ ${r.demoteDrawdownR}R`;
  return null;
}

/** Candidate key of a tracked setup: instrument:model, plus the session strategy for model S. */
export const candidateKey = (instrument: string, model: string | null, strategy?: string | null) =>
  `${instrument}:${model ?? "?"}${model === "S" && strategy ? `:${strategy}` : ""}`;
