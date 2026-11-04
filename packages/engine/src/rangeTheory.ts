import type { Candle } from './smc.js';
import { frameStructure } from './setup.js';
import { FRAME_BARS } from './backtest.js';
import { IST, NY, wallToUtc, zonedParts } from './sessions.js';
import { INSTRUMENTS, costInR, tradeWindows, type InstrumentId } from './instruments.js';
import { summarize } from './stats.js';
import type { SessionModelResult, SessionTrade } from './sessionModels.js';

/**
 * Range Theory: a box tied to the clock, not to the eye.
 *  1. The box: the first four hours of Tokyo, 01:00–05:00 London time, on 15M.
 *  2. The break: in the first two hours of London, two 15M closes outside the box pick the side.
 *  3. The order: a Fib from the box to the breakout extreme; a pending entry at 60%, the stop at 80%,
 *     the target at 3R, capped at half the daily ATR.
 *  4. Trade two: the same box and rules in the first two hours of New York. At most two trades a day.
 * Nifty has no Tokyo session: its box is the first hour of the NSE day and it trades the next two hours.
 * Fills are conservative (a bar that reaches the entry and the stop is a loss); flat at 16:00 New York.
 */

export interface RangeTheoryParams {
  /** retest: trade the break on its 60% retest. sweep: the break fails (a close back inside) — trade back through the box. */
  mode: 'retest' | 'sweep';
  /** Consecutive 15M closes outside the box that confirm the break. */
  closes: number;
  /** Fib anchor: the box's far side (low for a long) or its broken edge. */
  anchor: 'far' | 'near';
  entryFib: number;
  stopFib: number;
  /** Target in R before the daily-ATR cap. */
  rr: number;
  /** Target distance cap as a share of the daily ATR(14); null for no cap. */
  capAtr: number | null;
  /** Skip a setup whose capped target is under this many R. */
  minRR: number;
  /** London only, or London then New York. */
  sessions: 'london' | 'both';
  /** Only trade with the HTF structure trend. */
  trend: boolean;
  /** Skip days whose box is wider than this share of the daily ATR (null: no limit). */
  maxBoxAtr: number | null;
  /** Skip a setup whose round-trip cost would take more than this share of the risk. */
  maxCostR: number | null;
  costRate?: number;
}

export interface RangeTheoryData {
  ltf: readonly Candle[];
  ltfMs: number;
  htf?: readonly Candle[];
  htfMs?: number;
}

export interface RangeTrade extends SessionTrade { session: 'london' | 'ny' | 'india'; filledAt: number }

const HOUR = 3_600_000, DAY = 86_400_000, M15 = 900_000;
const LON = 'Europe/London';

/** Candles regrouped to 15M (no-op when they already are). */
export function to15m(c: readonly Candle[], ms: number): Candle[] {
  if (ms >= M15) return [...c];
  const out: Candle[] = [];
  for (const x of c) {
    const t = Math.floor(x.t / M15) * M15;
    const l = out[out.length - 1];
    if (l && l.t === t) { l.h = Math.max(l.h, x.h); l.l = Math.min(l.l, x.l); l.c = x.c; l.v = (l.v ?? 0) + (x.v ?? 0); }
    else out.push({ ...x, t });
  }
  return out;
}

function lowerBound(c: readonly Candle[], x: number): number {
  let lo = 0, hi = c.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c[m]!.t < x) lo = m + 1; else hi = m; }
  return lo;
}

/** Daily ATR(14) known before `t`, from New York 17:00-roll days. */
function dailyAtrFn(c: readonly Candle[]) {
  const days: { end: number; h: number; l: number; c: number }[] = [];
  const keyOf = (t: number) => { const p = zonedParts(t + 7 * HOUR, NY); return p.year * 10_000 + p.month * 100 + p.day; };
  let k = -1;
  for (const x of c) {
    const kk = keyOf(x.t);
    const d = days[days.length - 1];
    if (d && kk === k) { d.h = Math.max(d.h, x.h); d.l = Math.min(d.l, x.l); d.c = x.c; d.end = x.t; }
    else { days.push({ end: x.t, h: x.h, l: x.l, c: x.c }); k = kk; }
  }
  const trs = days.map((d, i) => (i ? Math.max(d.h - d.l, Math.abs(d.h - days[i - 1]!.c), Math.abs(d.l - days[i - 1]!.c)) : d.h - d.l));
  return (t: number): number | null => {
    const done = days.filter((d) => d.end < t - HOUR).length;
    if (done < 6) return null;
    const xs = trs.slice(Math.max(1, done - 14), done);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
}

export function runRangeTheory(id: InstrumentId, data: RangeTheoryData, p: RangeTheoryParams): SessionModelResult & { trades: RangeTrade[] } {
  const def = INSTRUMENTS[id];
  const costRate = p.costRate ?? def.costRate;
  const c = to15m(data.ltf, data.ltfMs);
  const india = tradeWindows(id).includes('india_q');
  const datr = dailyAtrFn(c);
  const htf = data.htf ?? [], htfMs = data.htfMs ?? HOUR;
  const trendAt = (T: number) => {
    let lo = 0, hi = htf.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (htf[m]!.t + htfMs <= T) lo = m + 1; else hi = m; }
    if (lo < 30) return null;
    return frameStructure(htf.slice(Math.max(0, lo - FRAME_BARS), lo)).trend;
  };

  const trades: RangeTrade[] = [];
  if (!c.length) return { trades, stats: summarize([]), from: 0, to: 0 };
  const tz = india ? IST : LON;
  const first = zonedParts(c[0]!.t, tz);
  let day = Date.UTC(first.year, first.month - 1, first.day);
  const lastT = c[c.length - 1]!.t;

  for (; day <= lastT + DAY; day += DAY) {
    const d = new Date(day);
    const [Y, M, D] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const box = india
      ? { a: wallToUtc(Y, M, D, 9, 15, IST), b: wallToUtc(Y, M, D, 10, 15, IST) }
      : { a: wallToUtc(Y, M, D, 1, 0, LON), b: wallToUtc(Y, M, D, 5, 0, LON) };
    const windows: { session: RangeTrade['session']; a: number; b: number; expire: number }[] = india
      ? [{ session: 'india', a: box.b, b: box.b + 2 * HOUR, expire: wallToUtc(Y, M, D, 14, 0, IST) }]
      : [
          { session: 'london', a: wallToUtc(Y, M, D, 8, 0, LON), b: wallToUtc(Y, M, D, 10, 0, LON), expire: wallToUtc(Y, M, D, 8, 0, NY) },
          ...(p.sessions === 'both' ? [{ session: 'ny' as const, a: wallToUtc(Y, M, D, 8, 0, NY), b: wallToUtc(Y, M, D, 10, 0, NY), expire: wallToUtc(Y, M, D, 12, 0, NY) }] : []),
        ];
    const flatAt = india ? wallToUtc(Y, M, D, 15, 15, IST) : wallToUtc(Y, M, D, 16, 0, NY);

    const ba = lowerBound(c, box.a), bb = lowerBound(c, box.b);
    if (bb - ba < ((box.b - box.a) / M15) * 0.75) continue; // holiday, weekend or data gap
    let hi = -Infinity, lo = Infinity;
    for (let i = ba; i < bb; i++) { hi = Math.max(hi, c[i]!.h); lo = Math.min(lo, c[i]!.l); }
    if (!(hi > lo)) continue;
    const atrD = datr(box.b);
    if (p.maxBoxAtr !== null && atrD !== null && hi - lo > p.maxBoxAtr * atrD) continue;

    let busyUntil = 0;
    const walk = (from: number, side: 'long' | 'short', entry: number, stop: number, target: number) => {
      const long = side === 'long', risk = Math.abs(entry - stop);
      for (let j = from; j < c.length; j++) {
        const x = c[j]!, end = x.t + M15;
        if (long ? x.l <= stop : x.h >= stop) return { exit: 'stop' as const, r: -1, exitAt: end, last: j };
        if (long ? x.h >= target : x.l <= target) return { exit: 'target' as const, r: Math.abs(target - entry) / risk, exitAt: end, last: j };
        if (end >= flatAt || j === c.length - 1) return { exit: 'time' as const, r: ((long ? 1 : -1) * (x.c - entry)) / risk, exitAt: end, last: j };
      }
      return null;
    };
    for (const w of windows) {
      const wa = Math.max(lowerBound(c, w.a), busyUntil);
      const wb = lowerBound(c, w.b);
      // 2: the break — `closes` consecutive closes on one side, inside the window.
      let side: 'long' | 'short' | null = null, conf = -1, breakAt = -1, run = 0, runSide: 'long' | 'short' | null = null;
      for (let i = wa; i < wb; i++) {
        const x = c[i]!;
        const s = x.c > hi ? 'long' : x.c < lo ? 'short' : null;
        if (s && s === runSide) run++; else { run = s ? 1 : 0; runSide = s; }
        if (run === 1) breakAt = i;
        if (s && run >= p.closes) { side = s; conf = i; break; }
      }
      if (!side) continue;
      const long = side === 'long';
      const T = c[conf]!.t + M15;
      if (p.trend && trendAt(T) !== (long ? 'up' : 'down')) continue;
      if (p.mode === 'sweep') {
        // The sweep morning: after the break, a close back inside the box flips the trade to the other side.
        let ext = long ? -Infinity : Infinity, back = -1;
        for (let j = breakAt; j < c.length; j++) {
          const x = c[j]!;
          if (x.t >= w.expire || x.t + M15 > flatAt) break;
          ext = long ? Math.max(ext, x.h) : Math.min(ext, x.l);
          if (j > conf && x.c < hi && x.c > lo) { back = j; break; }
        }
        if (back < 0) continue;
        const entry = c[back]!.c, buf = def.stopBuffer(entry);
        const sStop = long ? ext + buf : ext - buf;
        const risk = Math.abs(entry - sStop);
        if (!(risk > 0)) continue;
        const edge = long ? lo : hi;
        let dist = Math.abs(entry - edge);
        if (p.capAtr !== null && atrD !== null) dist = Math.min(dist, p.capAtr * atrD);
        dist = Math.min(dist, p.rr * risk);
        const plannedR = dist / risk;
        if (plannedR < p.minRR) continue;
        const costR = costInR({ costRate }, entry, sStop);
        if (p.maxCostR !== null && costR > p.maxCostR) continue;
        const fade: 'long' | 'short' = long ? 'short' : 'long';
        const target = fade === 'long' ? entry + dist : entry - dist;
        const res = walk(back + 1, fade, entry, sStop, target);
        if (!res) continue;
        trades.push({ side: fade, signalAt: c[back]!.t + M15, exitAt: res.exitAt, entry, stop: sStop, target, plannedR, rGross: res.r, rNet: res.r - costR, exit: res.exit, session: w.session, filledAt: c[back]!.t + M15 });
        busyUntil = res.last + 1;
        continue;
      }
      const anchor = p.anchor === 'far' ? (long ? lo : hi) : (long ? hi : lo);

      // 3: the order follows the breakout extreme until it fills or the window's order expires.
      let ext = long ? -Infinity : Infinity;
      for (let i = breakAt; i <= conf; i++) ext = long ? Math.max(ext, c[i]!.h) : Math.min(ext, c[i]!.l);
      let fill = -1, entry = 0, stop = 0;
      for (let j = conf + 1; j < c.length; j++) {
        const x = c[j]!;
        if (x.t >= w.expire || x.t + M15 > flatAt) break;
        const span = Math.abs(ext - anchor);
        entry = long ? ext - p.entryFib * span : ext + p.entryFib * span;
        stop = long ? ext - p.stopFib * span : ext + p.stopFib * span;
        if (long ? x.l <= entry : x.h >= entry) { fill = j; break; }
        ext = long ? Math.max(ext, x.h) : Math.min(ext, x.l);
      }
      if (fill < 0) continue;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;
      let dist = p.rr * risk;
      if (p.capAtr !== null && atrD !== null) dist = Math.min(dist, p.capAtr * atrD);
      const plannedR = dist / risk;
      if (plannedR < p.minRR) continue;
      const costR = costInR({ costRate }, entry, stop);
      if (p.maxCostR !== null && costR > p.maxCostR) continue;
      const target = long ? entry + dist : entry - dist;

      let exit: SessionTrade['exit'] = 'time', exitPx = NaN, exitAt = 0, last = fill;
      for (let j = fill; j < c.length; j++) {
        const x = c[j]!, end = x.t + M15;
        last = j;
        if (long ? x.l <= stop : x.h >= stop) { exit = 'stop'; exitPx = stop; exitAt = end; break; }
        if (j > fill && (long ? x.h >= target : x.l <= target)) { exit = 'target'; exitPx = target; exitAt = end; break; }
        // Still open at the end of the data (live): marked to the last close; the tracker resolves it later.
        if (end >= flatAt || j === c.length - 1) { exitPx = x.c; exitAt = end; break; }
      }
      if (!Number.isFinite(exitPx)) continue;
      const rGross = ((long ? 1 : -1) * (exitPx - entry)) / risk;
      trades.push({ side, signalAt: T, exitAt, entry, stop, target, plannedR, rGross, rNet: rGross - costR, exit, session: w.session, filledAt: c[fill]!.t });
      busyUntil = last + 1;
    }
  }
  return { trades, stats: summarize(trades.map((t) => t.rNet)), from: c[0]!.t, to: lastT };
}
