/**
 * Strategy League: every strategy keeps paper-trading on every venue it could run on, with that venue's
 * costs. Fixed, versioned gates move it through the stages; live slots per venue and market go to the
 * best record, and a decaying record is benched automatically. Pure functions.
 */

export type Venue = 'cfd' | 'delta' | 'coinswitch' | 'fyers';
export type Stage = 'paper' | 'candidate' | 'live_small' | 'live' | 'benched' | 'retired';
export const STAGES: Stage[] = ['paper', 'candidate', 'live_small', 'live', 'benched', 'retired'];
export const isLiveStage = (s: Stage) => s === 'live_small' || s === 'live';

/** Where a market's strategies can run, and the round-trip cost each venue adds beyond the engine's own. */
export function venuesFor(instrument: string): Venue[] {
  if (instrument === 'BTCUSDT.P' || instrument === 'XAUUSDT.P' || instrument === 'BTCUSD.SPOT') return ['delta', 'coinswitch'];
  if (instrument === 'NIFTY') return ['fyers'];
  return ['cfd'];
}

/** Extra cost per side as a fraction of price, on top of the costs already in the signal's net R. */
export const VENUE_EXTRA_COST: Record<Venue, number> = {
  cfd: 0,            // prop CFD spread is already in the instrument's cost rate
  delta: 0.0002,     // Delta BTC perp taker 0.05% vs the 0.03% the engine assumes for Binance
  coinswitch: 0.0003, // CoinSwitch futures taker, conservative until the fee schedule is confirmed
  fyers: 0,          // Nifty costs (STT, exchange, slippage) are already in the cost rate
};

/** Net R on a venue: the signal's net R minus the venue's extra round-trip cost, in R. */
export function venueNetR(netR: number, entry: number, stop: number, venue: Venue): number {
  const risk = Math.abs(entry - stop);
  return risk > 0 ? netR - (2 * VENUE_EXTRA_COST[venue] * entry) / risk : netR;
}

export const venueKey = (venue: Venue, instrument: string, model: string | null, strategy?: string | null) =>
  `${venue}/${instrument}:${model ?? '?'}${model === 'S' && strategy ? `:${strategy}` : ''}`;

export function parseVenueKey(key: string): { venue: Venue; instrument: string; model: string; strategy: string | null } | null {
  const m = key.match(/^(cfd|delta|coinswitch|fyers)\/([^:]+):([^:]+)(?::(.+))?$/);
  return m ? { venue: m[1] as Venue, instrument: m[2]!, model: m[3]!, strategy: m[4] ?? null } : null;
}

export interface LeagueTrade { at: number; netR: number }
export interface LeagueStats { n: number; days: number; expectancy: number; profitFactor: number | null; maxDrawdownR: number; netR: number; winRate: number; sd: number; lowerBound: number; score: number }

export function leagueStats(trades: LeagueTrade[]): LeagueStats {
  const xs = [...trades].sort((a, b) => a.at - b.at);
  const n = xs.length;
  const sum = xs.reduce((s, t) => s + t.netR, 0);
  const mean = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, t) => s + (t.netR - mean) ** 2, 0) / (n - 1)) : 0;
  const gains = xs.filter((t) => t.netR > 0).reduce((s, t) => s + t.netR, 0), losses = -xs.filter((t) => t.netR < 0).reduce((s, t) => s + t.netR, 0);
  let cum = 0, peak = 0, dd = 0;
  for (const t of xs) { cum += t.netR; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const r = (x: number, d = 3) => Number(x.toFixed(d));
  return {
    n, days: n ? Math.max(1, Math.round((xs.at(-1)!.at - xs[0]!.at) / 86_400_000)) : 0,
    expectancy: r(mean), profitFactor: losses > 0 ? r(gains / losses, 2) : gains > 0 ? null : 0, maxDrawdownR: r(dd, 2), netR: r(sum, 2),
    winRate: n ? r(xs.filter((t) => t.netR > 0).length / n) : 0, sd: r(sd),
    // One-sided 90% lower bound on expectancy: below zero means the edge is not established.
    lowerBound: n > 1 ? r(mean - (1.2816 * sd) / Math.sqrt(n)) : -Infinity,
    score: r(n > 1 && sd > 0 ? (mean / sd) * Math.sqrt(n) : 0),
  };
}

/** Gates v2.0, fixed before any result is seen. Changing them means a new version. */
export interface LeagueGates {
  version: string;
  paper: { minTrades: number; minDays: number; minExpectancy: number; minProfitFactor: number; maxDrawdownR: number };
  backtest: { minTrades: number; minProfitFactor: number };
  liveSmall: { minTrades: number; minExpectancy: number };
  demote: { lastN: number; drawdownMultiple: number; maxDrawdownR: number; slippageShare: number };
  cooldownDays: number;
  slotsPerMarket: number;
  swapMargin: number;
}
export const GATES_V2: LeagueGates = {
  version: '2.0',
  paper: { minTrades: 30, minDays: 21, minExpectancy: 0.1, minProfitFactor: 1.3, maxDrawdownR: 8 },
  backtest: { minTrades: 40, minProfitFactor: 1.2 },
  liveSmall: { minTrades: 15, minExpectancy: 0 },
  demote: { lastN: 30, drawdownMultiple: 1.5, maxDrawdownR: 10, slippageShare: 0.3 },
  cooldownDays: 7, slotsPerMarket: 1, swapMargin: 1.5,
};

export interface Check { label: string; ok: boolean; value: string }
const pf = (s: LeagueStats) => (s.profitFactor === null ? Infinity : s.profitFactor);

export function paperChecks(s: LeagueStats, g: LeagueGates, backtest?: { trades: number; profitFactor: number | null } | null): Check[] {
  return [
    { label: `${g.paper.minTrades}+ paper trades`, ok: s.n >= g.paper.minTrades, value: String(s.n) },
    { label: `over ${g.paper.minDays}+ days`, ok: s.days >= g.paper.minDays, value: `${s.days} d` },
    { label: `expectancy ≥ ${g.paper.minExpectancy}R`, ok: s.expectancy >= g.paper.minExpectancy, value: `${s.expectancy}R` },
    { label: `profit factor ≥ ${g.paper.minProfitFactor}`, ok: pf(s) >= g.paper.minProfitFactor, value: s.profitFactor === null ? '∞' : String(s.profitFactor) },
    { label: `drawdown ≤ ${g.paper.maxDrawdownR}R`, ok: s.maxDrawdownR <= g.paper.maxDrawdownR, value: `${s.maxDrawdownR}R` },
    { label: 'edge above zero at 90%', ok: s.lowerBound > 0, value: Number.isFinite(s.lowerBound) ? `${s.lowerBound}R` : '—' },
    ...(backtest ? [{ label: `backtest ${g.backtest.minTrades}+ trades, PF ≥ ${g.backtest.minProfitFactor}`, ok: backtest.trades >= g.backtest.minTrades && (backtest.profitFactor === null || backtest.profitFactor >= g.backtest.minProfitFactor), value: `${backtest.trades} · PF ${backtest.profitFactor ?? '∞'}` }] : []),
  ];
}

/** Why a live strategy must go back to paper, or null. */
export function demoteReason(recent: LeagueStats, sinceLive: LeagueStats, g: LeagueGates, opts: { backtestMaxDdR?: number | null; slippageR?: number | null } = {}): string | null {
  if (recent.n >= 10 && recent.lowerBound < 0 && recent.expectancy < 0) return `last ${recent.n} trades: ${recent.expectancy}R per trade, below zero`;
  const ddCap = opts.backtestMaxDdR ? Math.min(g.demote.maxDrawdownR, opts.backtestMaxDdR * g.demote.drawdownMultiple) : g.demote.maxDrawdownR;
  if (sinceLive.maxDrawdownR >= ddCap) return `drawdown since live ${sinceLive.maxDrawdownR}R ≥ ${Number(ddCap.toFixed(2))}R`;
  if (opts.slippageR && recent.expectancy > 0 && opts.slippageR / (recent.expectancy + opts.slippageR) > g.demote.slippageShare) return `slippage takes ${Math.round((opts.slippageR / (recent.expectancy + opts.slippageR)) * 100)}% of the edge`;
  return null;
}

export interface Entry { key: string; venue: Venue; instrument: string; stage: Stage; pinned: boolean; stageSince: number; paper: LeagueStats; recent: LeagueStats; sinceLive: LeagueStats; backtest?: { trades: number; profitFactor: number | null; maxDrawdownR?: number | null } | null }
export interface Move { key: string; from: Stage; to: Stage; reason: string }

/**
 * One League pass. Benches decaying live strategies, graduates live_small → live, marks paper strategies
 * that clear every gate as candidates, then fills each venue × market's live slots with the best
 * candidates (swapping out a clearly weaker live one). Pinned strategies never move.
 */
export function leaguePass(entries: Entry[], g: LeagueGates = GATES_V2, now = Date.now()): Move[] {
  const moves: Move[] = [];
  const stage = new Map(entries.map((e) => [e.key, e.stage]));
  const move = (e: Entry, to: Stage, reason: string) => { moves.push({ key: e.key, from: stage.get(e.key)!, to, reason }); stage.set(e.key, to); };
  for (const e of entries) {
    if (e.pinned) continue;
    const s = stage.get(e.key)!;
    if (isLiveStage(s)) {
      const why = demoteReason(e.recent, e.sinceLive, g, { backtestMaxDdR: e.backtest?.maxDrawdownR ?? null });
      if (why) { move(e, 'benched', why); continue; }
      if (s === 'live_small' && e.sinceLive.n >= g.liveSmall.minTrades && e.sinceLive.expectancy >= g.liveSmall.minExpectancy) move(e, 'live', `${e.sinceLive.n} trades at small size, ${e.sinceLive.expectancy}R per trade`);
      continue;
    }
    const ready = paperChecks(e.paper, g, e.backtest).every((c) => c.ok);
    if (s === 'paper' && ready) move(e, 'candidate', `cleared gates v${g.version}: ${e.paper.n} trades, ${e.paper.expectancy}R per trade, PF ${e.paper.profitFactor ?? '∞'}`);
    else if (s === 'candidate' && !ready) move(e, 'paper', 'no longer clears every gate');
    else if (s === 'benched' && now - e.stageSince >= g.cooldownDays * 86_400_000) move(e, 'paper', `cool-down of ${g.cooldownDays} days over`);
  }
  // Slots per venue × market.
  const groups = new Map<string, Entry[]>();
  for (const e of entries) groups.set(`${e.venue}/${e.instrument}`, [...(groups.get(`${e.venue}/${e.instrument}`) ?? []), e]);
  for (const list of groups.values()) {
    const live = list.filter((e) => isLiveStage(stage.get(e.key)!));
    const waiting = list.filter((e) => stage.get(e.key) === 'candidate').sort((a, b) => b.paper.score - a.paper.score);
    let free = g.slotsPerMarket - live.length;
    while (free > 0 && waiting.length) { const e = waiting.shift()!; move(e, 'live_small', `took a free slot (score ${e.paper.score})`); free--; }
    const best = waiting[0];
    const weakest = live.filter((e) => !e.pinned).sort((a, b) => a.paper.score - b.paper.score)[0];
    if (best && weakest && best.paper.score > Math.max(0, weakest.paper.score) * g.swapMargin && best.paper.expectancy > weakest.paper.expectancy) {
      move(weakest, 'benched', `replaced by ${best.key} (score ${best.paper.score} vs ${weakest.paper.score})`);
      move(best, 'live_small', `replaced ${weakest.key}`);
    }
  }
  return moves;
}
