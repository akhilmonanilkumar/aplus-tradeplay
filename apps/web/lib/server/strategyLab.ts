import "server-only";
import {
  ASIA_Q, INSTRUMENTS, LONDON_Q, NY, NY_Q, TF_MS, FRAME_BARS, STRUCTURE, frameStructure, runSessionModel, scanSignals, simulate, smcStructure, swingStructure, zonedParts,
  type InstrumentId, type ScanTfs, type SessionModelParams, type StrategyParams, type Tf,
} from "@aplus/engine";
import { loadHistory } from "@/lib/server/feeds";

/**
 * Strategy lab: candidate strategy families on a long walk-forward window, each judged against
 * criteria fixed before the run — at least 40 trades, profit factor ≥ 1.2 after costs, and net
 * positive in both the earlier and the later half of the period.
 */

export type Family = "a5" | "a15" | "session";

const WARM: Record<string, number> = { "1h": 32 * 86_400_000, "4h": 90 * 86_400_000, "15m": 8 * 86_400_000, "5m": 2 * 86_400_000 };
const r2 = (x: number) => Math.round(x * 100) / 100;
export const PASS = { minTrades: 40, minPf: 1.2 };

/** Model A on the entry TF: the live rules, then the trend core with fixed and partial exits. */
const A_VARIANTS: { id: string; label: string; params: Partial<StrategyParams> }[] = [
  { id: "live", label: "Live A+ rules", params: {} },
  { id: "core15", label: "Trend core 1.5R", params: { allowGradeA: true, requirePoi: false, requireCorrectHalf: false, minRR: 1.5 } },
  { id: "core2", label: "Trend core 2R", params: { allowGradeA: true, requirePoi: false, requireCorrectHalf: false, minRR: 2 } },
  { id: "core15p", label: "Trend core 1.5R, half off at 1R", params: { allowGradeA: true, requirePoi: false, requireCorrectHalf: false, minRR: 1.5, partialAtR: 1 } },
  { id: "core2p", label: "Trend core 2R, half off at 1R", params: { allowGradeA: true, requirePoi: false, requireCorrectHalf: false, minRR: 2, partialAtR: 1 } },
  { id: "coreHtfP", label: "Trend core HTF only 1.5R, half off at 1R", params: { allowGradeA: true, requirePoi: false, requireCorrectHalf: false, requireAlignment: false, minRR: 1.5, partialAtR: 1 } },
];

function sessionVariants(): { id: string; label: string; params: Omit<SessionModelParams, "costRate"> }[] {
  const out: { id: string; label: string; params: Omit<SessionModelParams, "costRate"> }[] = [];
  const ranges = [
    { id: "asia", name: "Asia range in London", rangeWindow: ASIA_Q, tradeWindow: LONDON_Q },
    { id: "ldn", name: "London range in NY", rangeWindow: LONDON_Q, tradeWindow: NY_Q },
  ];
  for (const r of ranges) {
    for (const trendFilter of [false, true]) {
      const tf = trendFilter ? " · with HTF trend" : "";
      out.push(
        { id: `${r.id}-fade${trendFilter ? "-t" : ""}`, label: `${r.name}: fade to opposite edge${tf}`, params: { kind: "fade", rangeWindow: r.rangeWindow, tradeWindow: r.tradeWindow, trendFilter, target: "opposite", rr: 2, minRR: 1, partialAtR: null, minRiskAtr: 0.5 } },
        { id: `${r.id}-fade-p${trendFilter ? "-t" : ""}`, label: `${r.name}: fade, half off at 1R${tf}`, params: { kind: "fade", rangeWindow: r.rangeWindow, tradeWindow: r.tradeWindow, trendFilter, target: "opposite", rr: 2, minRR: 1, partialAtR: 1, minRiskAtr: 0.5 } },
        { id: `${r.id}-bo${trendFilter ? "-t" : ""}`, label: `${r.name}: breakout 2R${tf}`, params: { kind: "breakout", rangeWindow: r.rangeWindow, tradeWindow: r.tradeWindow, trendFilter, target: "rr", rr: 2, minRR: 1, partialAtR: null, minRiskAtr: 0.5 } },
        { id: `${r.id}-bo-p${trendFilter ? "-t" : ""}`, label: `${r.name}: breakout 3R, half off at 1R${tf}`, params: { kind: "breakout", rangeWindow: r.rangeWindow, tradeWindow: r.tradeWindow, trendFilter, target: "rr", rr: 3, minRR: 1, partialAtR: 1, minRiskAtr: 0.5 } },
      );
    }
  }
  return out;
}

interface Row { id: string; label: string; trades: number; winRate: number; netR: number; avgR: number; pf: number | null; maxDDR: number; halves: [number, number]; pass: boolean; signals?: number; topRejects?: [string, number][] }

function row(id: string, label: string, trades: { signalAt: number; rNet: number }[], stats: { n: number; winRate: number; netR: number; avgR: number; profitFactor: number | null; maxDrawdownR: number }, mid: number): Row {
  const early = trades.filter((t) => t.signalAt < mid).reduce((a, t) => a + t.rNet, 0);
  const late = trades.filter((t) => t.signalAt >= mid).reduce((a, t) => a + t.rNet, 0);
  const pass = stats.n >= PASS.minTrades && (stats.profitFactor ?? 0) >= PASS.minPf && early > 0 && late > 0;
  return { id, label, trades: stats.n, winRate: r2(stats.winRate * 100), netR: r2(stats.netR), avgR: r2(stats.avgR), pf: stats.profitFactor !== null ? r2(stats.profitFactor) : null, maxDDR: r2(stats.maxDrawdownR), halves: [r2(early), r2(late)], pass };
}

const nyTime = (t: number) => { const p = zonedParts(t, NY); return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} NY`; };

/** HTF and POI structure as the engine sees it now: LuxAlgo-style swing (50) and internal (5), premium/discount, strong level. */
export async function structureReport(id: InstrumentId) {
  const def = INSTRUMENTS[id];
  const frames = [def.htf, def.poi] as Tf[];
  const out = await Promise.all(frames.map(async (tf) => {
    const to = Date.now();
    const set = await loadHistory(id, tf, to - (WARM[tf] ?? 15 * 86_400_000) * 2, to);
    const c = set.candles.slice(-FRAME_BARS);
    const lux = smcStructure(c, STRUCTURE);
    const frame = frameStructure(c);
    const prot = swingStructure(c, 3, 3);
    const at = (i: number) => (i >= 0 && c[i] ? nyTime(c[i]!.t) : null);
    const side = (st: typeof lux.swing) => ({
      trend: st.trend,
      high: Number.isFinite(st.high.level) ? { level: st.high.level, at: at(st.high.index), crossed: st.high.crossed } : null,
      low: Number.isFinite(st.low.level) ? { level: st.low.level, at: at(st.low.index), crossed: st.low.crossed } : null,
      breaks: st.breaks.slice(-6).map((b) => ({ kind: b.kind, dir: b.direction, level: b.level, at: at(b.index) })),
    });
    return {
      tf, source: set.source, bars: c.length, lastClose: c[c.length - 1]?.c, lastBar: at(c.length - 1),
      engineTrend: frame.trend,
      engineRange: frame.range,
      luxSwing: side(lux.swing),
      luxInternal: side(lux.internal),
      premiumDiscount: Number.isFinite(lux.trailing.top) ? { top: lux.trailing.top, topAt: at(lux.trailing.topIndex), bottom: lux.trailing.bottom, bottomAt: at(lux.trailing.bottomIndex), eq: (lux.trailing.top + lux.trailing.bottom) / 2 } : null,
      strong: lux.strong,
      protectedFallback: { trend: prot.trend, level: prot.protectedLevel ? { price: prot.protectedLevel.price, at: at(prot.protectedLevel.index) } : null },
    };
  }));
  return { instrument: id, frames: out };
}

export async function strategyLab(id: InstrumentId, family: Family, days = 180) {
  const t0 = Date.now();
  const def = INSTRUMENTS[id];
  days = Math.min(Math.max(days, 30), 200);
  const tfs: ScanTfs = family === "a15" ? { htf: "4h", poi: "1h", ltf: "15m" } : { htf: def.htf, poi: def.poi, ltf: def.ltf };
  const ltfMs = TF_MS[tfs.ltf];
  const to = Math.floor(Date.now() / ltfMs) * ltfMs;
  const from = to - days * 86_400_000;
  const load = (tf: Tf) => loadHistory(id, tf, from - (WARM[tf] ?? 0), to);
  const [htf, poi, ltf] = await Promise.all([load(tfs.htf), family === "session" ? Promise.resolve(null) : load(tfs.poi), load(tfs.ltf)]);
  const loadedMs = Date.now() - t0;
  const mid = (from + to) / 2;
  let rows: Row[];

  if (family === "session") {
    rows = sessionVariants().map((v) => {
      const r = runSessionModel(id, { htf: htf.candles, ltf: ltf.candles.filter((c) => c.t >= from), htfMs: TF_MS[tfs.htf], ltfMs }, v.params);
      return row(v.id, v.label, r.trades, r.stats, mid);
    });
  } else {
    const data = { htf: htf.candles, poi: poi!.candles, ltf: ltf.candles };
    // On 15M bars the sweep search and the order lifetime cover the same clock time as on 5M.
    const scale = family === "a15" ? { sweepLookback: 12, expiryBars: 4 } : { sweepLookback: 36, expiryBars: 12 };
    const scan = scanSignals(id, data, { windows: ["london_q", "ny_q"], sides: "both", sweepLookback: scale.sweepLookback, tfs });
    rows = A_VARIANTS.map((v) => {
      const r = simulate(id, data, scan, { ...v.params, ...scale });
      const closed = r.trades.filter((t) => t.outcome !== "open");
      return {
        ...row(v.id, v.label, closed, r.stats, mid),
        signals: r.signals,
        topRejects: Object.entries(r.rejected).sort((a, b) => b[1] - a[1]).slice(0, 3),
      };
    });
  }

  return {
    instrument: id, family, days, tfs, source: ltf.source, approx: ltf.approx, bars: ltf.candles.length,
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    criteria: `≥${PASS.minTrades} trades, PF ≥ ${PASS.minPf}, positive in both halves`,
    rows, loadMs: loadedMs, ms: Date.now() - t0,
  };
}
