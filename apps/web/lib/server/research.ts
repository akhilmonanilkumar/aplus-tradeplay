import "server-only";
import {
  INSTRUMENTS, NY, TF_MS, scanSignals, simulate, skippedImpact, wallToUtc, zonedParts,
  type InstrumentId, type ScanTrace, type StrategyParams,
} from "@aplus/engine";
import { loadHistory } from "@/lib/server/feeds";

/**
 * Rule research: one walk-forward scan of the last N days, simulated under the live rules and a
 * set of relaxed variants, plus a bar-by-bar replay of one New York day. Answers "why no trade"
 * and "what would a looser rule have done", on the same detector the autopilot runs.
 */

export const VARIANTS: { id: string; label: string; params: Partial<StrategyParams> }[] = [
  { id: "live", label: "Live rules (A+ only, 3R, limit at zone)", params: {} },
  { id: "gradeA", label: "+ grade A", params: { allowGradeA: true } },
  { id: "noHalf", label: "No premium/discount rule", params: { requireCorrectHalf: false } },
  { id: "htfOnly", label: "HTF trend only (15M may disagree)", params: { requireAlignment: false } },
  { id: "noPoi", label: "No 15M POI required", params: { requirePoi: false } },
  { id: "rr2", label: "Min R:R 2", params: { minRR: 2 } },
  { id: "shiftClose", label: "Enter at the shift close", params: { entryMode: "shift_close" } },
  { id: "loose", label: "Grade A + no half + HTF only + 2R", params: { allowGradeA: true, requireCorrectHalf: false, requireAlignment: false, minRR: 2 } },
  { id: "looseClose", label: "Loose + enter at shift close", params: { allowGradeA: true, requireCorrectHalf: false, requireAlignment: false, minRR: 2, entryMode: "shift_close" } },
  { id: "trendCore", label: "Trend core: HTF + 15M aligned, sweep, shift, 1.5R (no POI / half)", params: { allowGradeA: true, requirePoi: false, requireCorrectHalf: false, minRR: 1.5 } },
  { id: "trendCore2", label: "Trend core at 2R", params: { allowGradeA: true, requirePoi: false, requireCorrectHalf: false, minRR: 2 } },
  { id: "trendCoreHtf", label: "Trend core, HTF only (15M may disagree)", params: { allowGradeA: true, requirePoi: false, requireCorrectHalf: false, requireAlignment: false, minRR: 1.5 } },
];

const WARM: Record<string, number> = { "1h": 32 * 86_400_000, "4h": 90 * 86_400_000, "15m": 8 * 86_400_000, "5m": 2 * 86_400_000 };
const hm = (t: number) => { const p = zonedParts(t, NY); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Collapse a per-bar trace into runs of the same stage (times in New York). */
function segments(trace: ScanTrace[], side: "long" | "short") {
  const out: { from: string; to: string; stage: string; sweep: string | null; zone: string | null; pos: number | null; htf: string | null; m15: string | null }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (const x of trace.filter((y) => y.side === side)) {
    if (cur && cur.stage === x.stage && cur.sweep === x.sweep && cur.zone === x.zone && cur.htf === x.htf && cur.m15 === x.m15) { cur.to = hm(x.t); continue; }
    cur = { from: hm(x.t), to: hm(x.t), stage: x.stage, sweep: x.sweep, zone: x.zone, pos: x.pos !== null ? Math.round(x.pos) : null, htf: x.htf, m15: x.m15 };
    out.push(cur);
  }
  return out;
}

export async function research(id: InstrumentId, opts: { days?: number; day?: string } = {}) {
  const t0 = Date.now();
  const def = INSTRUMENTS[id];
  const days = Math.min(Math.max(opts.days ?? 30, 5), 90);
  const to = Math.floor(Date.now() / TF_MS[def.ltf]) * TF_MS[def.ltf];
  const from = to - days * 86_400_000;
  const [htf, poi, ltf] = await Promise.all([
    loadHistory(id, def.htf, from - (WARM[def.htf] ?? 0), to),
    loadHistory(id, def.poi, from - (WARM[def.poi] ?? 0), to),
    loadHistory(id, def.ltf, from - (WARM[def.ltf] ?? 0), to),
  ]);
  const data = { htf: htf.candles, poi: poi.candles, ltf: ltf.candles };

  // The New York day to replay (default: today in New York).
  const nyNow = zonedParts(Date.now(), NY);
  const [y, m, d] = (opts.day ?? `${nyNow.year}-${nyNow.month}-${nyNow.day}`).split("-").map(Number) as [number, number, number];
  const dayStart = wallToUtc(y, m, d, 0, 0, NY);
  const dayEnd = dayStart + 86_400_000;

  const scan = scanSignals(id, data, { windows: ["london_q", "ny_q"], sides: "both", sweepLookback: 36, traceFrom: dayStart });
  const trace = scan.trace.filter((x) => x.t < dayEnd);
  const inDay = (t: number) => t >= dayStart && t < dayEnd;

  const variants = VARIANTS.map((v) => {
    const r = simulate(id, data, scan, v.params);
    const closed = r.trades.filter((t) => t.outcome !== "open");
    // Stability check: the same rules on the earlier and the later half of the period.
    const mid = (r.from + r.to) / 2;
    const half = (early: boolean) => { const x = closed.filter((t) => (t.signalAt < mid) === early); return { n: x.length, netR: r2(x.reduce((a, t) => a + t.rNet, 0)) }; };
    return {
      id: v.id, label: v.label,
      trades: r.stats.n, winRate: r2(r.stats.winRate * 100), netR: r2(r.stats.netR), avgR: r2(r.stats.avgR),
      pf: r.stats.profitFactor !== null ? r2(r.stats.profitFactor) : null, maxDDR: r2(r.stats.maxDrawdownR),
      signals: r.signals, ranAway: r.cancelled.ranAway, expired: r.cancelled.expired + r.cancelled.windowClosed,
      halves: [half(true), half(false)],
      day: {
        trades: closed.concat(r.trades.filter((t) => t.outcome === "open")).filter((t) => inDay(t.signalAt)).map((t) => ({
          at: hm(t.signalAt), side: t.side, window: t.window, entry: t.entry, stop: t.stop, target: t.target, plannedR: r2(t.plannedR), outcome: t.outcome, rNet: r2(t.rNet),
        })),
        skipped: r.skipped.filter((s) => inDay(s.t)).map((s) => ({
          at: hm(s.t), side: s.side, window: s.window, why: s.fails.join(" + ") || s.why, entry: s.entry, stop: s.stop, target: s.target, plannedR: r2(s.plannedR), wouldHave: s.outcome, rNet: s.rNet !== null ? r2(s.rNet) : null,
        })),
      },
      skippedImpact: v.id === "live" ? skippedImpact(r.skipped).slice(0, 12).map((g) => ({ ...g, netR: r2(g.netR) })) : undefined,
    };
  });

  return {
    instrument: id, source: ltf.source, approx: ltf.approx, days, bars: ltf.candles.length,
    day: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    variants,
    replay: { long: segments(trace, "long"), short: segments(trace, "short") },
    ms: Date.now() - t0,
  };
}
