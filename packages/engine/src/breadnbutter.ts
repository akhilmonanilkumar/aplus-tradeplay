import type { Candle } from './smc.js';
import { atr } from './smc.js';
import { frameStructure } from './setup.js';
import { FRAME_BARS } from './backtest.js';
import { ASIA_Q, IST, NY, WINDOWS_BY_ID, wallToUtc, windowOnDateOf, zonedParts, type SessionWindow } from './sessions.js';
import { INSTRUMENTS, costInR, tradeWindows, type InstrumentId } from './instruments.js';
import { summarize } from './stats.js';
import type { SessionModelResult, SessionTrade } from './sessionModels.js';

/**
 * BreadnButter: yesterday's range as today's battlefield.
 *  1. Mark yesterday's high and low (17:00 New York roll).
 *  2. Today opens inside that range, so liquidity rests on both sides.
 *  3. The first push towards one side fails to take it. A correlated market that does take its own
 *     level (SMT divergence) is the clue that this side is protected.
 *  4. The target is the other side of yesterday's range.
 *  5. A displacement candle away from the protected extreme leaves a fresh fair-value gap; a limit at
 *     the gap is the entry, the stop sits beyond the protected extreme (or the gap's origin).
 * Shorts mirror longs. One trade per day, flat at the close (16:00 New York; 15:15 IST for Nifty).
 * Fills are conservative: a bar that reaches the limit and the stop counts as a loss.
 */

export interface BnbParams {
  /** Today's open must sit inside yesterday's range. */
  insideOpen: boolean;
  /** Correlated-market divergence: off, or required (needs `corr` data). */
  smt: 'off' | 'require';
  /** Only trade with the HTF structure trend. */
  trend: boolean;
  /** Entry in the discount half of yesterday's range for longs (premium for shorts). */
  discount: boolean;
  /** Where setups may form: the instrument's kill zones, or the whole morning. */
  window: 'kz' | 'morning';
  /** Stop beyond the protected extreme (swing) or beyond the candle that opened the gap (fvg). */
  stop: 'swing' | 'fvg';
  /** Limit at the gap's near edge or its middle. */
  entry: 'edge' | 'mid';
  /** Minimum reward:risk to yesterday's opposite extreme. */
  minRR: number;
  /** Displacement body as a multiple of the 5M ATR(14). */
  dispAtr: number;
  /** The first push must travel at least this many ATRs from the open. */
  pushAtr: number;
  /** Half off at this R and the stop to entry; null keeps the full position to target. */
  partialAtR: number | null;
  /** Skip a setup whose round-trip cost would take more than this share of the risk (null: no cap). */
  maxCostR: number | null;
  /** The displacement must close beyond the highest high (lowest low) printed since the protected extreme. */
  shift: boolean;
  /** The failed push must have swept the Asia range (20:00–24:00 New York) on its way. */
  asiaSweep: boolean;
  costRate?: number;
}

export interface BnbData {
  ltf: readonly Candle[];
  ltfMs: number;
  htf?: readonly Candle[];
  htfMs?: number;
  /** Correlated market on the same bar times; sign -1 for an inverse pair (gold vs the dollar). */
  corr?: { ltf: readonly Candle[]; sign: 1 | -1 } | null;
}

export interface BnbTrade extends SessionTrade { protectedAt: number; smt: boolean }

const HOUR = 3_600_000;
const MORNING_NY: SessionWindow = { id: 'bnb_morning', name: 'Morning', start: { hour: 1, minute: 0 }, end: { hour: 12, minute: 0 }, tz: NY };
const MORNING_IST: SessionWindow = { id: 'bnb_morning_in', name: 'Morning', start: { hour: 9, minute: 20 }, end: { hour: 14, minute: 30 }, tz: IST };

/** NY trading-day key with the 17:00 roll, memoised per UTC hour. */
function dayKeyFn() {
  const m = new Map<number, string>();
  return (t: number) => {
    const h = Math.floor(t / HOUR);
    let k = m.get(h);
    if (k === undefined) { const p = zonedParts(h * HOUR + 7 * HOUR, NY); k = `${p.year}-${p.month}-${p.day}`; m.set(h, k); }
    return k;
  };
}

interface Day { key: string; a: number; b: number; hi: number; lo: number; open: number }

function splitDays(c: readonly Candle[], key: (t: number) => string, ltfMs: number): Day[] {
  const out: Day[] = [];
  for (let i = 0; i < c.length; i++) {
    const k = key(c[i]!.t);
    const d = out[out.length - 1];
    if (d && d.key === k) { d.b = i + 1; d.hi = Math.max(d.hi, c[i]!.h); d.lo = Math.min(d.lo, c[i]!.l); }
    else out.push({ key: k, a: i, b: i + 1, hi: c[i]!.h, lo: c[i]!.l, open: c[i]!.o });
  }
  // A day needs a real session behind it (FX Sunday stubs and holidays are skipped as "yesterday").
  const minBars = Math.floor((3 * HOUR) / ltfMs);
  return out.filter((d) => d.b - d.a >= minBars);
}

/** Running high/low of the correlated market per day, looked up by time. */
function corrIndex(c: readonly Candle[], key: (t: number) => string, ltfMs: number) {
  const days = splitDays(c, key, ltfMs);
  const prev = new Map<string, { hi: number; lo: number }>();
  for (let i = 1; i < days.length; i++) prev.set(days[i]!.key, { hi: days[i - 1]!.hi, lo: days[i - 1]!.lo });
  const at = new Map<number, number>(c.map((x, i) => [x.t, i]));
  const dayOf = new Map<string, Day>(days.map((d) => [d.key, d]));
  /** Did the correlated market take its previous-day low (side 'low') or high by bar time t? */
  return (t: number, side: 'low' | 'high'): boolean | null => {
    const k = key(t);
    const p = prev.get(k), d = dayOf.get(k);
    if (!p || !d) return null;
    let end = at.get(t);
    if (end === undefined) { end = d.a; while (end + 1 < d.b && c[end + 1]!.t <= t) end++; }
    for (let i = d.a; i <= end; i++) {
      if (side === 'low' ? c[i]!.l < p.lo : c[i]!.h > p.hi) return true;
    }
    return false;
  };
}

export function runBreadnButter(id: InstrumentId, data: BnbData, p: BnbParams): SessionModelResult & { trades: BnbTrade[] } {
  const def = INSTRUMENTS[id];
  const costRate = p.costRate ?? def.costRate;
  const { ltf, ltfMs } = data;
  const key = dayKeyFn();
  const days = splitDays(ltf, key, ltfMs);
  const india = tradeWindows(id).includes('india_q');
  const windows: SessionWindow[] = p.window === 'morning'
    ? [india ? MORNING_IST : MORNING_NY]
    : tradeWindows(id).map((w) => WINDOWS_BY_ID.get(w)).filter((w): w is SessionWindow => !!w);
  const inWindow = (t: number) => windows.some((w) => { const x = windowOnDateOf(t, w); return x.startUtc <= t && t < x.endUtc; });
  const corr = data.corr ? { took: corrIndex(data.corr.ltf, key, ltfMs), sign: data.corr.sign } : null;
  const htf = data.htf ?? [], htfMs = data.htfMs ?? HOUR;
  const trendAt = (T: number) => {
    let lo = 0, hi = htf.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (htf[m]!.t + htfMs <= T) lo = m + 1; else hi = m; }
    if (lo < 30) return null;
    return frameStructure(htf.slice(Math.max(0, lo - FRAME_BARS), lo)).trend;
  };

  const trades: BnbTrade[] = [];
  for (let di = 1; di < days.length; di++) {
    const d = days[di]!, y = days[di - 1]!;
    const PDH = y.hi, PDL = y.lo;
    if (!(PDH > PDL)) continue;
    if (p.insideOpen && !(d.open > PDL && d.open < PDH)) continue;
    const first = ltf[d.a]!;
    const nyD = zonedParts(first.t + 7 * HOUR, NY);
    const flatAt = india
      ? wallToUtc(nyD.year, nyD.month, nyD.day, 15, 15, IST)
      : wallToUtc(nyD.year, nyD.month, nyD.day, 16, 0, NY);
    // Nifty's session sits inside one IST day; its NY key is that day too (02:30 IST roll), so the IST date is the key's date.
    const mid = (PDH + PDL) / 2;
    const asiaW = windowOnDateOf(ltf[d.a]!.t + 4 * HOUR, ASIA_Q);
    let aHi = -Infinity, aLo = Infinity;
    for (let i = d.a; i < d.b && ltf[i]!.t < asiaW.endUtc; i++) if (ltf[i]!.t >= asiaW.startUtc) { aHi = Math.max(aHi, ltf[i]!.h); aLo = Math.min(aLo, ltf[i]!.l); }

    let low = Infinity, lowAt = -1, high = -Infinity, highAt = -1;
    let done = false;
    for (let i = d.a; i < d.b && !done; i++) {
      const bar = ltf[i]!;
      if (bar.l < low) { low = bar.l; lowAt = i; }
      if (bar.h > high) { high = bar.h; highAt = i; }
      // A setup is confirmed at the close of the bar after the displacement (the gap's third candle).
      const k = i - 1;
      if (k - 1 < d.a || i - d.a < 6) continue;
      const T = bar.t + ltfMs;
      if (T >= flatAt || !inWindow(bar.t)) continue;
      const a = atr(ltf.slice(Math.max(0, k - 30), k + 1), 14);
      if (!(a > 0)) continue;
      const disp = ltf[k]!, before = ltf[k - 1]!;

      for (const side of ['long', 'short'] as const) {
        const long = side === 'long';
        // 1–3: the first push towards yesterday's extreme failed to take it.
        const ext = long ? low : high, extAt = long ? lowAt : highAt;
        if (long ? !(ext > PDL) : !(ext < PDH)) continue;
        if (extAt >= k) continue; // the push came before the displacement
        if (long ? d.open - ext < p.pushAtr * a : ext - d.open < p.pushAtr * a) continue;
        if (p.asiaSweep && (india || !Number.isFinite(aLo) || ltf[extAt]!.t < asiaW.endUtc || (long ? !(ext < aLo) : !(ext > aHi)))) continue;
        if (p.shift) {
          let lvl = long ? -Infinity : Infinity;
          for (let q = extAt; q < k; q++) lvl = long ? Math.max(lvl, ltf[q]!.h) : Math.min(lvl, ltf[q]!.l);
          if (k - extAt < 3 || (long ? !(disp.c > lvl) : !(disp.c < lvl))) continue;
        }
        // 5: displacement away from the protected extreme leaving a fresh gap.
        const body = long ? disp.c - disp.o : disp.o - disp.c;
        if (body < p.dispAtr * a) continue;
        const gapTop = long ? bar.l : before.l, gapBot = long ? before.h : bar.h;
        if (!(gapTop > gapBot)) continue;
        let smt = false;
        if (corr) {
          const want = (long ? 1 : -1) * corr.sign > 0 ? 'low' : 'high';
          smt = corr.took(ltf[extAt]!.t, want) === true;
        }
        if (p.smt === 'require' && !smt) continue;
        if (p.trend) {
          const tr = trendAt(T);
          if (tr !== (long ? 'up' : 'down')) continue;
        }
        const entry = p.entry === 'mid' ? (gapTop + gapBot) / 2 : long ? gapTop : gapBot;
        if (p.discount && (long ? entry > mid : entry < mid)) continue;
        const buf = def.stopBuffer(entry);
        const stop = p.stop === 'swing' ? (long ? ext - buf : ext + buf) : (long ? Math.min(before.l, disp.l) - buf : Math.max(before.h, disp.h) + buf);
        const target = long ? PDH : PDL;
        const risk = Math.abs(entry - stop);
        if (!(risk > 0) || (long ? !(target > entry && stop < entry) : !(target < entry && stop > entry))) continue;
        if (def.minStopPct && risk < (entry * def.minStopPct) / 100) continue;
        if (risk < 0.25 * a) continue;
        const plannedR = Math.abs(target - entry) / risk;
        if (plannedR < p.minRR) continue;
        const costR = costInR({ costRate }, entry, stop);
        if (p.maxCostR !== null && costR > p.maxCostR) continue;

        // Work the limit until the window closes; cancel if price reaches the target or the stop first.
        let filled = -1;
        for (let j = i + 1; j < d.b; j++) {
          const x = ltf[j]!;
          if (x.t + ltfMs > flatAt || !inWindow(x.t)) break;
          if (long ? x.l <= entry : x.h >= entry) { filled = j; break; }
          if (long ? x.h >= target || x.l <= stop : x.l <= target || x.h >= stop) break;
        }
        if (filled < 0) continue;
        let curStop = stop, banked = 0, exit: SessionTrade['exit'] = 'time', exitPx = NaN, exitAt = 0;
        for (let j = filled; j < d.b; j++) {
          const x = ltf[j]!;
          const end = x.t + ltfMs;
          if (long ? x.l <= curStop : x.h >= curStop) { exit = 'stop'; exitPx = curStop; exitAt = end; break; }
          if (j > filled && (long ? x.h >= target : x.l <= target)) { exit = 'target'; exitPx = target; exitAt = end; break; }
          const fav = long ? (x.h - entry) / risk : (entry - x.l) / risk;
          if (j > filled && p.partialAtR !== null && !banked && fav >= p.partialAtR) { banked = p.partialAtR; curStop = entry; }
          if (end >= flatAt || j === d.b - 1) { exit = 'time'; exitPx = x.c; exitAt = end; break; }
        }
        if (!Number.isFinite(exitPx)) continue;
        const runner = ((long ? 1 : -1) * (exitPx - entry)) / risk;
        const rGross = banked ? 0.5 * banked + 0.5 * runner : runner;
        trades.push({ side, signalAt: T, exitAt, entry, stop, target, plannedR, rGross, rNet: rGross - costR, exit, protectedAt: ltf[extAt]!.t, smt });
        done = true;
        break;
      }
    }
  }
  return { trades, stats: summarize(trades.map((t) => t.rNet)), from: ltf[0]?.t ?? 0, to: ltf[ltf.length - 1]?.t ?? 0 };
}
