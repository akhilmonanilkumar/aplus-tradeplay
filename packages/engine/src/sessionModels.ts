import type { Candle } from './smc.js';
import { atr } from './smc.js';
import { frameStructure } from './setup.js';
import { FRAME_BARS } from './backtest.js';
import { ASIA_Q, LONDON_Q, NY, NY_Q, wallToUtc, windowOnDateOf, zonedParts, type SessionWindow } from './sessions.js';
import { INSTRUMENTS, costInR, type InstrumentId } from './instruments.js';
import { summarize, type RStats } from './stats.js';

/**
 * Session-range models: the range one session builds (Asia, London) traded in the next window.
 * fade     — a wick through the range edge that closes back inside: trade back into the range.
 * breakout — the first close beyond the range edge: trade the break.
 * Market entry at the signal bar close, stop checked before target inside a bar, one trade per
 * model per New York day, flat at 16:00 New York. Costs are charged in R like the backtester.
 */

export interface SessionModelParams {
  kind: 'fade' | 'breakout';
  /** Window that builds the range (the latest instance that ended before the bar). */
  rangeWindow: SessionWindow;
  /** Window in which signals are taken. */
  tradeWindow: SessionWindow;
  /** Only trade in the direction of the HTF structure trend. */
  trendFilter: boolean;
  /** Fade target: the opposite range edge, or a fixed multiple of risk. */
  target: 'opposite' | 'rr';
  rr: number;
  /** Minimum reward:risk for an 'opposite' target. */
  minRR: number;
  partialAtR: number | null;
  /** Risk floor as a multiple of the entry-TF ATR(14). */
  minRiskAtr: number;
  costRate?: number;
}

export interface SessionTrade {
  side: 'long' | 'short';
  signalAt: number;
  exitAt: number;
  entry: number;
  stop: number;
  target: number;
  plannedR: number;
  rGross: number;
  rNet: number;
  exit: 'target' | 'stop' | 'time';
}

export interface SessionModelResult {
  trades: SessionTrade[];
  stats: RStats;
  from: number;
  to: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Time-zone lookups memoised per UTC hour: New York offsets are whole hours, so the date and hour are constant within one. */
function hourly<T>(f: (t: number) => T): (t: number) => T {
  const m = new Map<number, T>();
  return (t) => { const k = Math.floor(t / HOUR); let v = m.get(k); if (v === undefined) { v = f(k * HOUR); m.set(k, v); } return v; };
}

/** Index of the first candle with t >= x. */
function lowerBound(c: readonly Candle[], x: number): number {
  let lo = 0, hi = c.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c[m]!.t < x) lo = m + 1; else hi = m; }
  return lo;
}

export function runSessionModel(
  id: InstrumentId,
  data: { htf: readonly Candle[]; ltf: readonly Candle[]; htfMs: number; ltfMs: number },
  p: SessionModelParams,
): SessionModelResult {
  const def = INSTRUMENTS[id];
  const costRate = p.costRate ?? def.costRate;
  const { htf, ltf, htfMs, ltfMs } = data;
  const trades: SessionTrade[] = [];
  const ranges = new Map<number, { hi: number; lo: number } | null>();
  const tradedDays = new Set<string>();

  const tradeInst = hourly((t) => windowOnDateOf(t, p.tradeWindow));
  const inTradeWindow = (t: number) => { const w = tradeInst(t); return w.weekday !== 'Sat' && w.weekday !== 'Sun' && w.startUtc <= t && t < w.endUtc; };
  const nyDay = hourly((t) => zonedParts(t, NY));
  const rangeInst = hourly((t) => {
    const w = windowOnDateOf(t, p.rangeWindow);
    return w.endUtc > t ? windowOnDateOf(t - DAY, p.rangeWindow) : w;
  });
  const rangeFor = (t: number) => {
    const w = rangeInst(t);
    if (!ranges.has(w.startUtc)) {
      const a = lowerBound(ltf, w.startUtc), b = lowerBound(ltf, w.endUtc);
      let hi = -Infinity, lo = Infinity;
      for (let k = a; k < b; k++) { hi = Math.max(hi, ltf[k]!.h); lo = Math.min(lo, ltf[k]!.l); }
      // A range needs most of its bars (holiday or data gap otherwise).
      const want = (w.endUtc - w.startUtc) / ltfMs;
      ranges.set(w.startUtc, b - a >= want * 0.6 && hi > lo ? { hi, lo } : null);
    }
    return ranges.get(w.startUtc)!;
  };
  const trendAt = (T: number) => {
    const k = lowerBound(htf, T - htfMs + 1); // htf bars closed by T
    if (k < 30) return null;
    return frameStructure(htf.slice(Math.max(0, k - FRAME_BARS), k)).trend;
  };

  let open: { side: 'long' | 'short'; signalAt: number; entry: number; stop: number; initialStop: number; target: number; risk: number; costR: number; banked: number; flatAt: number; plannedR: number } | null = null;
  const close = (exitPx: number, at: number, why: SessionTrade['exit']) => {
    const o = open!;
    const runner = ((o.side === 'long' ? 1 : -1) * (exitPx - o.entry)) / o.risk;
    const rGross = o.banked ? 0.5 * o.banked + 0.5 * runner : runner;
    trades.push({ side: o.side, signalAt: o.signalAt, exitAt: at, entry: o.entry, stop: o.initialStop, target: o.target, plannedR: o.plannedR, rGross, rNet: rGross - o.costR, exit: why });
    open = null;
  };

  for (let i = 20; i < ltf.length; i++) {
    const bar = ltf[i]!;
    const T = bar.t + ltfMs;
    if (open) {
      const o = open;
      const long = o.side === 'long';
      if (long ? bar.l <= o.stop : bar.h >= o.stop) close(o.stop, T, 'stop');
      else if (long ? bar.h >= o.target : bar.l <= o.target) close(o.target, T, 'target');
      else {
        const fav = long ? (bar.h - o.entry) / o.risk : (o.entry - bar.l) / o.risk;
        if (p.partialAtR !== null && !o.banked && fav >= p.partialAtR) { o.banked = p.partialAtR; o.stop = o.entry; }
        if (T >= o.flatAt) close(bar.c, T, 'time');
      }
      if (open) continue;
    }
    if (!inTradeWindow(bar.t)) continue;
    const nyD = nyDay(bar.t);
    const dayKey = `${nyD.year}-${nyD.month}-${nyD.day}`;
    if (tradedDays.has(dayKey)) continue;
    const r = rangeFor(bar.t);
    if (!r) continue;

    let side: 'long' | 'short' | null = null, extreme = 0;
    if (p.kind === 'fade') {
      if (bar.h > r.hi && bar.c < r.hi && bar.c > r.lo) { side = 'short'; extreme = bar.h; }
      else if (bar.l < r.lo && bar.c > r.lo && bar.c < r.hi) { side = 'long'; extreme = bar.l; }
    } else {
      const prev = ltf[i - 1]!;
      if (bar.c > r.hi && prev.c <= r.hi) { side = 'long'; extreme = (r.hi + r.lo) / 2; }
      else if (bar.c < r.lo && prev.c >= r.lo) { side = 'short'; extreme = (r.hi + r.lo) / 2; }
    }
    if (!side) continue;
    if (p.trendFilter) {
      const tr = trendAt(T);
      if (tr !== (side === 'long' ? 'up' : 'down')) continue;
    }
    const entry = bar.c;
    const a = atr(ltf.slice(Math.max(0, i - 30), i + 1), 14);
    const buf = def.stopBuffer(entry);
    let stop = p.kind === 'fade' ? (side === 'long' ? extreme - buf : extreme + buf) : extreme;
    const minRisk = a * p.minRiskAtr;
    if ((side === 'long' ? entry - stop : stop - entry) < minRisk) stop = side === 'long' ? entry - minRisk : entry + minRisk;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const minStop = def.minStopPct ? (entry * def.minStopPct) / 100 : 0;
    if (risk < minStop) continue;
    let target = side === 'long' ? entry + p.rr * risk : entry - p.rr * risk;
    if (p.kind === 'fade' && p.target === 'opposite') {
      target = side === 'long' ? r.hi : r.lo;
      if (Math.abs(target - entry) / risk < p.minRR) continue;
    }
    tradedDays.add(dayKey);
    open = {
      side, signalAt: T, entry, stop, initialStop: stop, target, risk, costR: costInR({ costRate }, entry, stop), banked: 0,
      flatAt: wallToUtc(nyD.year, nyD.month, nyD.day, 16, 0, NY),
      plannedR: Math.abs(target - entry) / risk,
    };
  }
  if (open) close(ltf[ltf.length - 1]!.c, ltf[ltf.length - 1]!.t + ltfMs, 'time');

  return { trades, stats: summarize(trades.map((t) => t.rNet)), from: ltf[0]?.t ?? 0, to: ltf[ltf.length - 1]?.t ?? 0 };
}

/** The four session-range strategies; each runs in variants (HTF trend filter, half off at 1R). */
export const SESSION_STRATEGIES = [
  { id: 'asia-fade', name: 'Tokyo Trap', kind: 'fade', range: 'Asia', trade: 'London Q', summary: 'London wicks through the Asia range edge and closes back inside: trade back to the other side.' },
  { id: 'asia-bo', name: 'Tokyo Break', kind: 'breakout', range: 'Asia', trade: 'London Q', summary: 'The first London close beyond the Asia range edge: trade the break.' },
  { id: 'ldn-fade', name: 'London Trap', kind: 'fade', range: 'London', trade: 'NY Q', summary: 'New York wicks through the London range edge and closes back inside: trade back to the other side.' },
  { id: 'ldn-bo', name: 'London Break', kind: 'breakout', range: 'London', trade: 'NY Q', summary: 'The first New York close beyond the London range edge: trade the break.' },
] as const;

/** Display name of a session variant id, e.g. "asia-fade-p-t" → "Tokyo Trap · ½ at 1R · trend". */
export function strategyName(id: string | null | undefined): string {
  if (!id) return 'Session strategy';
  const base = SESSION_STRATEGIES.find((s) => id === s.id || id.startsWith(`${s.id}-`));
  if (!base) return id;
  const rest = id.slice(base.id.length).split('-').filter(Boolean);
  const tags = [...(rest.includes('p') ? [base.kind === 'fade' ? '½ at 1R' : '3R · ½ at 1R'] : []), ...(rest.includes('t') ? ['trend'] : [])];
  return [base.name, ...tags].join(' · ');
}

function sessionVariants(): { id: string; label: string; params: Omit<SessionModelParams, 'costRate'> }[] {
  const out: { id: string; label: string; params: Omit<SessionModelParams, 'costRate'> }[] = [];
  const ranges = [
    { id: 'asia', name: 'Asia range in London', rangeWindow: ASIA_Q, tradeWindow: LONDON_Q },
    { id: 'ldn', name: 'London range in NY', rangeWindow: LONDON_Q, tradeWindow: NY_Q },
  ];
  for (const r of ranges) {
    for (const trendFilter of [false, true]) {
      const tf = trendFilter ? ' · with HTF trend' : '';
      out.push(
        { id: `${r.id}-fade${trendFilter ? '-t' : ''}`, label: `${r.name}: fade to opposite edge${tf}`, params: { kind: 'fade', rangeWindow: r.rangeWindow, tradeWindow: r.tradeWindow, trendFilter, target: 'opposite', rr: 2, minRR: 1, partialAtR: null, minRiskAtr: 0.5 } },
        { id: `${r.id}-fade-p${trendFilter ? '-t' : ''}`, label: `${r.name}: fade, half off at 1R${tf}`, params: { kind: 'fade', rangeWindow: r.rangeWindow, tradeWindow: r.tradeWindow, trendFilter, target: 'opposite', rr: 2, minRR: 1, partialAtR: 1, minRiskAtr: 0.5 } },
        { id: `${r.id}-bo${trendFilter ? '-t' : ''}`, label: `${r.name}: breakout 2R${tf}`, params: { kind: 'breakout', rangeWindow: r.rangeWindow, tradeWindow: r.tradeWindow, trendFilter, target: 'rr', rr: 2, minRR: 1, partialAtR: null, minRiskAtr: 0.5 } },
        { id: `${r.id}-bo-p${trendFilter ? '-t' : ''}`, label: `${r.name}: breakout 3R, half off at 1R${tf}`, params: { kind: 'breakout', rangeWindow: r.rangeWindow, tradeWindow: r.tradeWindow, trendFilter, target: 'rr', rr: 3, minRR: 1, partialAtR: 1, minRiskAtr: 0.5 } },
      );
    }
  }
  return out;
}

/** Session-range strategy variants traded in the lab and logged live: Asia range in London, London range in NY, fades and breakouts, with and without the HTF trend filter. */
export const SESSION_VARIANTS: readonly { id: string; label: string; params: Omit<SessionModelParams, 'costRate'> }[] = sessionVariants();
