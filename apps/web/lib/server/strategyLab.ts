import "server-only";
import {
  ENTRY_MODELS, INSTRUMENTS, MODEL_IDS, NY, SESSION_VARIANTS, TF_MS, FRAME_BARS, lossDiagnostics, usHighImpactTimes, STRUCTURE, frameStructure, runSessionModel, scanSignals, simulate, smcStructure, swingStructure, zonedParts,
  type InstrumentId, type ScanTfs, type StrategyParams, type Tf,
} from "@aplus/engine";
import { historyEnd, loadFrames, loadHistory } from "@/lib/server/feeds";

/**
 * Strategy lab: candidate strategy families on a long walk-forward window, each judged against
 * criteria fixed before the run — at least 40 trades, profit factor ≥ 1.2 after costs, and net
 * positive in both the earlier and the later half of the period.
 */

export type Family = "a5" | "a15" | "session" | "models";

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

interface Row { id: string; label: string; model?: string; diagnostics?: ReturnType<typeof lossDiagnostics>; trades: number; winRate: number; netR: number; avgR: number; pf: number | null; maxDDR: number; halves: [number, number]; pass: boolean; signals?: number; topRejects?: [string, number][] }

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

/**
 * Each entry model alone, under three rule sets: the live rules (stop beyond the furthest anchor,
 * nearest target paying 2R), the playbook's (stop just beyond the entry zone, nearest real target,
 * 3R minimum, never stretched), and the playbook stop with the live target rule.
 */
const LOOSE: Partial<StrategyParams> = { requireCorrectHalf: false, requirePoi: false, allowGradeA: true };

function modelVariants(): { id: string; label: string; model: string; params: Partial<StrategyParams>; diagnose: boolean }[] {
  const out: { id: string; label: string; model: string; params: Partial<StrategyParams>; diagnose: boolean }[] = [];
  for (const m of MODEL_IDS) {
    const em = ENTRY_MODELS[m];
    const base: Partial<StrategyParams> = { models: [m], allowAllModels: true, allowGradeA: !em.aPlusEligible };
    out.push(
      { id: `${m}-live`, label: `${m} · ${em.name} — live rules (furthest stop, first target ≥ 2R)`, model: m, params: base, diagnose: true },
      { id: `${m}-spec`, label: `${m} · ${em.name} — playbook (zone stop, nearest target, 3R)`, model: m, params: { ...base, stopMode: "zone", targetMode: "nearest", minRR: 3 }, diagnose: true },
      { id: `${m}-zone`, label: `${m} · ${em.name} — zone stop, first target ≥ 2R`, model: m, params: { ...base, stopMode: "zone" }, diagnose: false },
      // Location boxes off (premium/discount, POI, one soft miss): enough trades to see why the trigger itself loses.
      { id: `${m}-loose`, label: `${m} · ${em.name} — live rules, location boxes off`, model: m, params: { ...base, ...LOOSE }, diagnose: true },
    );
  }
  out.push(
    { id: "all-loose", label: "All models · live rules, location boxes off", model: "all", params: { models: [...MODEL_IDS], allowAllModels: true, ...LOOSE }, diagnose: true },
    { id: "all-loose-spec", label: "All models · playbook stop and target, location boxes off", model: "all", params: { models: [...MODEL_IDS], allowAllModels: true, ...LOOSE, stopMode: "zone", targetMode: "nearest", minRR: 3 }, diagnose: true },
  );
  return out;
}

export async function strategyLab(id: InstrumentId, family: Family, days = 180, opts: { m1?: boolean } = {}) {
  const t0 = Date.now();
  const def = INSTRUMENTS[id];
  days = Math.min(Math.max(days, 30), 200);
  const tfs: ScanTfs = family === "a15" ? { htf: "4h", poi: "1h", ltf: "15m" } : { htf: def.htf, poi: def.poi, ltf: def.ltf };
  // 1M for model H is heavy; the lab loads it only when asked and for at most 60 days.
  const withM1 = family === "models" && opts.m1 === true && days <= 60;
  const ltfMs = TF_MS[tfs.ltf];
  const to = historyEnd();
  const from = to - days * 86_400_000;
  const frames = (family === "session" ? [tfs.ltf, tfs.htf] : [tfs.ltf, tfs.htf, tfs.poi]).map((tf) => ({ tf, from: from - (WARM[tf] ?? 0) }));
  const [ltf, htf, poi = null] = await loadFrames(id, frames, to);
  const m1 = withM1 ? (await loadFrames(id, [{ tf: "1m", from }], to, { source: ltf.source }))[0]!.candles : undefined;
  // NFP and FOMC releases (no historical calendar): box 6 news filter and model I.
  const news = usHighImpactTimes(from - 7 * 86_400_000, to);
  const loadedMs = Date.now() - t0;
  const mid = (from + to) / 2;
  let rows: Row[];

  if (family === "session") {
    rows = SESSION_VARIANTS.map((v) => {
      const r = runSessionModel(id, { htf: htf.candles, ltf: ltf.candles.filter((c) => c.t >= from), htfMs: TF_MS[tfs.htf], ltfMs }, v.params);
      return row(v.id, v.label, r.trades, r.stats, mid);
    });
  } else {
    const data = { htf: htf.candles, poi: poi!.candles, ltf: ltf.candles, news, m1 };
    // On 15M bars the sweep search and the order lifetime cover the same clock time as on 5M.
    const scale = family === "a15" ? { sweepLookback: 12, expiryBars: 4 } : { sweepLookback: 36, expiryBars: 12 };
    const scan = scanSignals(id, data, { windows: ["london_q", "ny_q"], sides: "both", sweepLookback: scale.sweepLookback, tfs });
    const variants = family === "models" ? modelVariants() : A_VARIANTS.map((v) => ({ ...v, model: undefined, diagnose: false }));
    rows = variants.map((v) => {
      const r = simulate(id, data, scan, { ...v.params, ...scale });
      const closed = r.trades.filter((t) => t.outcome !== "open");
      return {
        ...row(v.id, v.label, closed, r.stats, mid),
        ...(v.model ? { model: v.model } : {}),
        ...(v.diagnose && closed.length ? { diagnostics: lossDiagnostics(closed) } : {}),
        signals: r.signals,
        topRejects: Object.entries(r.rejected).sort((a, b) => b[1] - a[1]).slice(0, 3),
      };
    });
  }

  return {
    instrument: id, family, days, tfs, news: news.length, m1Bars: m1?.length ?? 0, source: ltf.source, approx: ltf.approx, partial: ltf.note?.startsWith("Partial") ? ltf.note : null, bars: ltf.candles.length,
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    criteria: `≥${PASS.minTrades} trades, PF ≥ ${PASS.minPf}, positive in both halves`,
    rows, loadMs: loadedMs, ms: Date.now() - t0,
  };
}
