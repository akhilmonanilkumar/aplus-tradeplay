import { fairValueGaps, pivots, smcStructure, type Candle, type Trend } from './smc.js';
import { orderBlocks } from './zones.js';
import { analyzeSetup, STRUCTURE, type AnalyzeOptions, type SetupAnalysis } from './setup.js';
import type { ModelId } from './models.js';

/**
 * Entry-model detector: every model of the playbook (Trade Finder Pro §6, A+ Edge §6) read from
 * the same closed candles the gate sees. Each setup carries its entry, the structural levels
 * that invalidate it and the zone it enters from; `planSetup` turns that into a stop and target
 * under the chosen stop / target rule, so models are compared on one footing.
 */

export interface Anchor { v: number; l: string }

export interface ModelSetup {
  model: ModelId;
  side: 'long' | 'short';
  /** Entry-TF bar (index into the entry candles) at whose close the setup became actionable. */
  index: number;
  entry: number;
  /** limit = order at `entry`; market = filled at the signal bar close. */
  entryType: 'limit' | 'market';
  /** Structural invalidation levels behind the entry: sweep wick, entry zone, 15M POI. */
  anchors: Anchor[];
  /** Far edge of the zone the entry comes from (stop rule "just beyond the entry zone"). */
  zoneAnchor: Anchor;
  /** Target labels this model aims for first (model F: the opposite side of the Asia range). */
  preferTargets?: string[];
  /** Minimum R the target must pay (model H aims far). */
  minTargetR?: number;
  /** Stop rule this model always uses (model H: the tiny 1M zone). */
  stopMode?: StopMode;
  shifted: boolean;
  /** Gate model checks (ModelCheck ids). */
  checks: Record<string, boolean>;
  /** Stable id of the setup (dedupe across passes): model, side and the bar that defines it. */
  key: string;
  /** One line describing the trigger. */
  detail: string;
  /** Liquidity that was swept, when there was a sweep. */
  sweep: { t: number; level: number; label: string; wick: number } | null;
}

export type StopMode = 'structural' | 'zone';
export type TargetMode = 'first_ge_min' | 'nearest';

export interface PlanOptions {
  /** structural = beyond the furthest anchor (sweep wick, entry zone, POI); zone = beyond the entry zone. */
  stopMode: StopMode;
  /** first_ge_min = nearest real level paying at least minRR; nearest = nearest real level (never stretched). */
  targetMode: TargetMode;
  minRR: number;
}

export interface SetupPlan {
  entry: number;
  stop: number;
  target: number;
  targetLabel: string;
  stopAnchor: string;
  plannedR: number;
  targets: { level: number; label: string; r: number }[];
}

export const DEFAULT_PLAN: PlanOptions = { stopMode: 'structural', targetMode: 'first_ge_min', minRR: 2 };

/** Stop and target for a setup. Null when nothing structural sits behind the entry or no target exists. */
export function planSetup(s: ModelSetup, ctx: { pool: SetupAnalysis['pool']; stopBuf: number }, o: PlanOptions): SetupPlan | null {
  const long = s.side === 'long';
  const beyond = (x: Anchor) => Number.isFinite(x.v) && (long ? x.v < s.entry : x.v > s.entry);
  const mode = s.stopMode ?? o.stopMode;
  const all = s.anchors.filter(beyond);
  if (!all.length) return null;
  const furthest = all.reduce((m, x) => (long ? (x.v < m.v ? x : m) : (x.v > m.v ? x : m)));
  const anchor = mode === 'zone' && beyond(s.zoneAnchor) ? s.zoneAnchor : furthest;
  const stop = long ? anchor.v - ctx.stopBuf : anchor.v + ctx.stopBuf;
  const risk = Math.abs(s.entry - stop);
  if (!(risk > 0)) return null;
  const seen = new Set<string>();
  const targets = ctx.pool
    .filter((x) => Number.isFinite(x.level) && (long ? x.level > s.entry + risk * 0.25 : x.level < s.entry - risk * 0.25))
    .sort((x, y) => (long ? x.level - y.level : y.level - x.level))
    .filter((x) => { const k = x.level.toFixed(4); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((x) => ({ level: x.level, label: x.label, r: Math.abs(x.level - s.entry) / risk }));
  if (!targets.length) return null;
  const need = Math.max(o.minRR, s.minTargetR ?? 0);
  const preferred = s.preferTargets ? targets.filter((x) => s.preferTargets!.includes(x.label)) : [];
  const pick = (list: typeof targets) => (o.targetMode === 'nearest' && !s.minTargetR ? list[0] : list.find((x) => x.r >= need) ?? list[0]);
  const t = (preferred.length ? pick(preferred) : undefined) ?? pick(targets)!;
  return { entry: s.entry, stop, target: t.level, targetLabel: t.label, stopAnchor: anchor.l, plannedR: t.r, targets };
}

export interface DetectOptions extends AnalyzeOptions {
  /** Instrument id: model E is gold only. */
  instrument?: string;
  /** Live session window id (model F needs London Q). */
  windowId?: string | null;
  /** 1M candles closed by now (model H). */
  m1?: readonly Candle[];
  /** High-impact release times (model I). */
  newsTimes?: readonly number[];
  /** Only setups actionable within this many entry-TF bars of the last closed bar (default 0 = the last bar). */
  recentBars?: number;
}

const GOLD = new Set(['XAUUSD', 'XAUUSDT.P']);

/**
 * Every model setup for one side. The analysis is the gate's input (HTF, half, POI, sweep);
 * setups are the models whose trigger fired within `recentBars` of the last closed bar.
 */
export function detectModels(side: 'long' | 'short', htf: readonly Candle[], poi: readonly Candle[], ltf: readonly Candle[], opts: DetectOptions = {}): { a: SetupAnalysis; setups: ModelSetup[] } {
  const a = analyzeSetup(side, htf, poi, ltf, opts);
  const setups: ModelSetup[] = [];
  const last = ltf.length - 1;
  const recent = (i: number) => i >= last - (opts.recentBars ?? 0) && i <= last;
  const long = side === 'long';
  const want: Trend = long ? 'up' : 'down';
  const trendSide = a.htfTrend === null || a.htfTrend === want;
  const far = (z: { top: number; bottom: number }) => (long ? z.bottom : z.top);
  const near = (z: { top: number; bottom: number }) => (long ? z.top : z.bottom);
  const poiAnchor: Anchor[] = a.inside ? [{ v: far(a.inside), l: a.inside.label }] : [];
  const sw = a.sweep;
  const swAnchor: Anchor[] = sw ? [{ v: sw.wick, l: `sweep of ${sw.label}` }] : [];
  const shiftIdx = a.shift?.t ? ltf.findIndex((c) => c.t === a.shift!.t) : -1;
  const behind = (entry: number, x: number) => (long ? x < entry : x > entry);
  const add = (s: Omit<ModelSetup, 'side' | 'sweep'>) => setups.push({ ...s, side, sweep: sw ? { t: sw.t, level: sw.level, label: sw.label, wick: sw.wick } : null });

  if (sw && shiftIdx > 0) {
    // The 5M zone that caused the shift: last opposite candle of the displacement (model A entry).
    const ob = orderBlocks(ltf, 2, 2).filter((o) => o.direction === want && o.index >= sw.index - 3 && o.index <= shiftIdx).pop();
    let entry = ob ? near(ob) : a.shift!.level;
    if (!behind(entry, sw.wick)) entry = a.shift!.level;
    if (!behind(entry, sw.wick)) entry = NaN;
    const obA: Anchor[] = ob ? [{ v: far(ob), l: '5M OB' }] : [];
    const zoneAnchor: Anchor = ob && behind(entry, far(ob)) ? { v: far(ob), l: '5M OB' } : { v: sw.wick, l: `sweep of ${sw.label}` };
    const shiftKey = `${sw.t}:${ltf[shiftIdx]!.t}`;
    if (Number.isFinite(entry) && recent(shiftIdx)) {
      const base = { index: shiftIdx, entry, entryType: 'limit' as const, anchors: [...swAnchor, ...obA, ...poiAnchor], zoneAnchor, shifted: true };
      // A — market shift → pullback (with the trend); G — the same structure against the HTF trend.
      if (trendSide) add({ ...base, model: 'A', checks: {}, key: `A:${side}:${shiftKey}`, detail: `sweep of ${sw.label} → 5M shift → limit at the shift zone` });
      else add({ ...base, model: 'G', checks: { fractal_shift: true }, key: `G:${side}:${shiftKey}`, detail: `counter-trend: sweep of ${sw.label} → 5M shift against the HTF ${a.htfTrend}` });

      // C — sweep → OB → FVG: limit at the FVG the displacement left inside / next to that OB.
      if (ob) {
        const fvg = fairValueGaps(ltf).filter((f) => f.direction === want && f.index >= ob.index && f.index <= shiftIdx + 1 && (f.filledAt === null || f.filledAt > shiftIdx)).pop();
        // The limit sits between the OB's far edge and the shift close.
        if (fvg && behind(ltf[shiftIdx]!.c, near(fvg)) && behind(near(fvg), far(ob))) {
          add({ ...base, model: 'C', entry: near(fvg), zoneAnchor: { v: far(ob), l: '5M OB' }, checks: { ob_fvg: true }, key: `C:${side}:${shiftKey}`, detail: `sweep → 5M OB → FVG ${fmt(fvg.bottom)}–${fmt(fvg.top)}` });
        }
      }

      // B — flip zone: an opposing 5M zone that price broke through on the way to the shift.
      const flip = orderBlocks(ltf, 2, 2)
        .filter((o) => o.direction !== want && o.index >= sw.index - 30 && o.index < shiftIdx && behind(ltf[shiftIdx]!.c, long ? o.top : o.bottom))
        .filter((o) => {
          // Price closed through the opposing zone after it formed (the failed reaction).
          const edge = long ? o.top : o.bottom;
          for (let k = Math.max(o.breakIndex, sw.index) + 1; k <= shiftIdx; k++) if (long ? ltf[k]!.c > edge : ltf[k]!.c < edge) return true;
          return false;
        })
        .pop();
      if (flip) {
        const e = long ? flip.top : flip.bottom;
        const fz: Anchor = { v: long ? flip.bottom : flip.top, l: '5M flip zone' };
        if (behind(e, fz.v)) {
          add({ ...base, model: 'B', entry: e, anchors: [...swAnchor, fz, ...poiAnchor], zoneAnchor: fz, checks: { failed_opposing_zone: true }, key: `B:${side}:${shiftKey}`, detail: `opposing 5M zone ${fmt(flip.bottom)}–${fmt(flip.top)} failed and flipped` });
        }
      }

      // D — institutional precision: the POI swept liquidity when it formed; its first tap was the
      // inducement and the sweep took the low (high) of that first tap.
      if (a.inside?.liquidityStory && sw.label.startsWith('5M swing')) {
        const z = a.inside;
        const first = ltf.findIndex((c) => c.t >= z.t && c.l <= z.top && c.h >= z.bottom);
        const tap = first >= 0 ? pivots(ltf, 3, 3).find((p) => p.kind === (long ? 'low' : 'high') && p.index >= first && p.index < sw.index && Math.abs(p.price - sw.level) < 1e-9) : undefined;
        if (tap) add({ ...base, model: 'D', checks: { first_tap_swept: true }, key: `D:${side}:${shiftKey}`, detail: `first tap of ${z.label} (${fmt(tap.price)}) swept, then 5M shift` });
      }

      // F — Asia sweep in London: Asia high/low taken with the bias, then the shift; aims for the other side.
      if (trendSide && sw.label.startsWith('Asia') && opts.windowId === 'london_q') {
        add({ ...base, model: 'F', checks: { asia_swept: true }, preferTargets: [long ? 'Asia high' : 'Asia low', long ? 'Range high' : 'Range low'], key: `F:${side}:${shiftKey}`, detail: `${sw.label} swept in London → 5M shift` });
      }

      // I — post-news: the sweep and shift came 30–120 min after a high-impact release.
      const rel = (opts.newsTimes ?? []).filter((n) => n <= sw.t && ltf[shiftIdx]!.t + 1 >= n + 30 * 60_000 && ltf[shiftIdx]!.t <= n + 120 * 60_000).pop();
      if (trendSide && rel !== undefined) add({ ...base, model: 'I', checks: {}, key: `I:${side}:${shiftKey}`, detail: `sweep and shift ${Math.round((ltf[shiftIdx]!.t - rel) / 60_000)} min after a high-impact release` });
    }

    // H — sniper: the shift ran away without a pullback; a 1M internal break in the trade direction
    // leaves a tiny zone to join from, with a far target.
    if (opts.m1?.length && Number.isFinite(entry) && shiftIdx < last && trendSide) {
      const after = ltf.slice(shiftIdx + 1);
      const filled = after.some((c) => (long ? c.l <= entry : c.h >= entry));
      const risk0 = Math.abs(entry - (long ? Math.min(sw.wick, ...obA.map((x) => x.v)) : Math.max(sw.wick, ...obA.map((x) => x.v))));
      const ran = after.some((c) => (long ? c.h >= entry + risk0 : c.l <= entry - risk0));
      const shiftT = ltf[shiftIdx]!.t;
      if (!filled && ran) {
        const m = opts.m1.filter((c) => c.t >= shiftT - 30 * 60_000);
        if (m.length > 30) {
          const st = smcStructure(m, { internal: STRUCTURE.internal, swing: STRUCTURE.swing });
          const brk = st.internal.breaks.filter((b) => b.direction === want).pop();
          const tEnd = ltf[last]!.t + (ltf[last]!.t - ltf[last - 1]!.t);
          if (brk && m[brk.index]!.t >= tEnd - 5 * 60_000 && m[brk.index]!.t > shiftT) {
            const mob = orderBlocks(m, 2, 2).filter((o) => o.direction === want && o.index <= brk.index && o.index >= brk.pivotIndex - 3).pop();
            if (mob && behind(m[brk.index]!.c, near(mob))) {
              const z: Anchor = { v: far(mob), l: '1M zone' };
              add({ model: 'H', index: last, entry: near(mob), entryType: 'limit', anchors: [z], zoneAnchor: z, stopMode: 'zone', minTargetR: 5, shifted: true, checks: { fractal_shift: true }, key: `H:${side}:${m[brk.index]!.t}`, detail: `shift ran away; 1M ${brk.kind} through ${fmt(brk.level)} → 1M zone` });
            }
          }
        }
      }
    }
  }

  // E — gold sweep entry (aggressive): in the POI, enter on the sweep candle's close; stop beyond the protected wick.
  if (sw && GOLD.has(opts.instrument ?? '') && trendSide && a.inside && recent(sw.index)) {
    const e = ltf[sw.index]!.c;
    const wick: Anchor = { v: sw.wick, l: `sweep of ${sw.label}` };
    if (behind(e, sw.wick)) add({ model: 'E', index: sw.index, entry: e, entryType: 'market', anchors: [wick, ...poiAnchor], zoneAnchor: wick, shifted: false, checks: {}, key: `E:${side}:${sw.t}`, detail: `aggressive: entered on the sweep of ${sw.label}` });
  }

  return { a, setups };
}

const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
