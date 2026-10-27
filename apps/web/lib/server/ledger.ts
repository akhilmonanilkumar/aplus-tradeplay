import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EDGE_RULES, EDGE_WINDOWS, INSTRUMENTS, SESSION_VARIANTS, TF_MS, detectModels, evaluateGate, isFxWeekend, isInWindow, liveDesk, planSetup, runSessionModel,
  type Candle, type GateResult, type InstrumentId, type ModelSetup, type SetupAnalysis, type SetupPlan,
} from "@aplus/engine";
import { loadCandles, loadHistory } from "@/lib/server/feeds";
import type { CalEvent } from "@/lib/server/news";

/**
 * Paper ledger: every entry model and session strategy, logged on every pass. Each setup the
 * detector finds goes into `signals` once (keyed by model, side and the bar that defines it)
 * with its gate verdict, the plan under the live rules and under the playbook's stricter rules,
 * and the context it formed in. Outcomes are resolved on candles by the bot-ledger tracker,
 * so setups that would not be traded are measured too. Paper orders go in for the ones the
 * gate would trade (A+, or grade A for models that are never A+).
 */

export interface LedgerConfig { instrument: InstrumentId; mode: string; filters?: { minRR?: number } | null }
export interface LedgerSettings { counter_trend_allowed?: boolean; advanced_models_allowed?: boolean; news_block_minutes?: number }
export interface Tradeable { signalId: string; side: "long" | "short"; plan: { entry: number; stop: number; target: number } }

/** Session strategies run on one instrument per underlying (the others read the same market). */
const SESSION_INSTRUMENTS = new Set<InstrumentId>(["XAUUSD", "BTCUSDT.P"]);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function windowAt(t: number) {
  return EDGE_WINDOWS.find((w) => isInWindow(t, w)) ?? null;
}

export async function modelLedger(db: SupabaseClient, cfg: LedgerConfig, ctx: { calendar: CalEvent[]; settings: LedgerSettings | null }): Promise<{ logged: number; tradeable: Tradeable[]; note: string }> {
  const id = cfg.instrument;
  const def = INSTRUMENTS[id];
  const tfMs = TF_MS[def.ltf];
  const now = Date.now();
  const [htf, poi, ltf] = await Promise.all([loadCandles(id, def.htf, 500), loadCandles(id, def.poi, 500), loadCandles(id, def.ltf, 300)]);
  // 1M for model H from an unmetered feed (one pull per pass).
  const m1 = await loadHistory(id, "1m", now - 300 * 60_000, now).then((x) => x.candles).catch(() => [] as Candle[]);
  const minRR = cfg.filters?.minRR ?? EDGE_RULES.minRR;
  const desk = liveDesk(id);
  const blockMin = ctx.settings?.news_block_minutes ?? EDGE_RULES.newsBlockMinutes;
  const releases = ctx.calendar.filter((e) => e.impact === "high" && e.desks.includes(desk)).map((e) => e.at);
  const newsTimes = releases.filter((t) => t <= now);
  const strict = { counterTrendAllowed: ctx.settings?.counter_trend_allowed, advancedModelsAllowed: ctx.settings?.advanced_models_allowed };
  const paperCfg = { counterTrendAllowed: true, advancedModelsAllowed: true, aggressiveEntryAllowed: true };

  const known = await db.from("signals").select("key:meta->>key").eq("instrument", id).gte("created_at", new Date(now - 2 * 86_400_000).toISOString());
  const seen = new Set(((known.data ?? []) as { key: string | null }[]).map((r) => r.key).filter((k): k is string => !!k));

  const rows: Record<string, unknown>[] = [];
  const meta: { key: string; tradeable: boolean; side: "long" | "short"; plan: SetupPlan }[] = [];
  const gateFor = (a: SetupAnalysis, s: ModelSetup, plan: SetupPlan, T: number, config: Record<string, boolean | undefined>): GateResult => {
    const win = windowAt(T - tfMs);
    const last = newsTimes.filter((n) => n <= T).pop();
    return evaluateGate({
      htfTrend: a.htfTrend, poiTfTrend: a.poiTrend, side: s.side, price: a.price, range: a.range!,
      poi: { inside: !!a.inside, fresh: a.inside?.fresh ?? false, trendAligned: true, liquidityStory: a.inside?.liquidityStory ?? false, createdBos: a.inside?.createdBos ?? true },
      swept: !!s.sweep, shifted: s.shifted, modelChecks: s.checks,
      timing: { inWindow: !!win && !(def.fxHours && isFxWeekend(T)), newsClear: !releases.some((n) => Math.abs(n - T) <= blockMin * 60_000), windowId: win?.id ?? null, minutesSinceNews: last !== undefined ? (T - last) / 60_000 : null },
      plan: { entry: plan.entry, stop: plan.stop, target: plan.target, targetIsStructural: true, stopIsStructural: true },
      minRR, minStopPct: def.minStopPct, model: s.model, instrument: id === "XAUUSDT.P" ? "XAUUSD" : id, config,
    });
  };

  for (const side of ["long", "short"] as const) {
    const { a, setups } = detectModels(side, htf.candles, poi.candles, ltf.candles, {
      now, stopBuffer: def.stopBuffer, minRR, instrument: id, windowId: windowAt(now)?.id ?? null, m1, newsTimes, recentBars: 3,
    });
    if (!a.range) continue;
    for (const s0 of setups) {
      if (seen.has(s0.key)) continue;
      seen.add(s0.key);
      const bar = ltf.candles[s0.index]!;
      const T = bar.t + tfMs;
      const s = s0.entryType === "market" ? { ...s0, entry: bar.c } : s0;
      const plan = planSetup(s, a, { stopMode: "structural", targetMode: "first_ge_min", minRR });
      if (!plan) continue;
      const spec = planSetup(s, a, { stopMode: "zone", targetMode: "nearest", minRR: 3 });
      const paper = gateFor(a, s, plan, T, paperCfg);
      const edge = gateFor(a, s, plan, T, strict);
      const tradeable = !paper.blockers.length && (paper.verdict === "GO" || (paper.grade === "A" && paper.boxes.every((b) => b.status === "pass" || b.status === "warn")));
      rows.push({
        instrument: id, side, model: s.model, session_window: windowAt(T - tfMs)?.id ?? null,
        entry: plan.entry, stop: plan.stop, target: plan.target, rr: r3(plan.plannedR), grade: paper.grade, gate: paper.boxes,
        state: tradeable ? "ARMED" : "LOGGED", edge_version: "3.1", source: "autopilot", outcome: "pending", created_at: new Date(T).toISOString(),
        meta: {
          key: s.key, detail: s.detail, entryType: s.entryType, tradeable, mode: cfg.mode,
          paper: { verdict: paper.verdict, blockers: paper.blockers, softMisses: paper.softMisses, waitingFor: paper.waitingFor },
          edge: { verdict: edge.verdict, grade: edge.grade, blockers: edge.blockers },
          stopAnchor: plan.stopAnchor, targetLabel: plan.targetLabel, targets: plan.targets.slice(0, 6).map((t) => ({ ...t, r: r3(t.r) })),
          spec: spec ? { stop: spec.stop, target: spec.target, targetLabel: spec.targetLabel, stopAnchor: spec.stopAnchor, rr: r3(spec.plannedR) } : null,
          sweep: s.sweep, zone: a.inside ? { label: a.inside.label, top: a.inside.top, bottom: a.inside.bottom, liquidityStory: a.inside.liquidityStory } : null,
          htf: a.htfTrend, poiTrend: a.poiTrend, pos: a.pos === null ? null : Math.round(a.pos), half: a.zone,
          dataSource: ltf.source, m1Bars: m1.length,
        },
      });
      meta.push({ key: s.key, tradeable, side, plan });
    }
  }

  // Session-range strategies: a signal is the bar that triggered the variant; logged as model S.
  if (SESSION_INSTRUMENTS.has(id)) {
    const ses = await loadCandles(id, def.ltf, 1000);
    const htfMs = TF_MS[def.htf];
    for (const v of SESSION_VARIANTS) {
      const r = runSessionModel(id, { htf: htf.candles, ltf: ses.candles, htfMs, ltfMs: tfMs }, v.params);
      for (const t of r.trades.filter((x) => x.signalAt >= now - 20 * 60_000)) {
        const key = `S:${v.id}:${t.side}:${t.signalAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const win = windowAt(t.signalAt - tfMs);
        rows.push({
          instrument: id, side: t.side, model: "S", session_window: win?.id ?? null,
          entry: t.entry, stop: t.stop, target: t.target, rr: r3(t.plannedR), grade: "S", gate: [],
          state: "ARMED", edge_version: "3.1", source: "autopilot", outcome: "pending", created_at: new Date(t.signalAt).toISOString(),
          meta: { key, strategy: v.id, detail: v.label, entryType: "market", tradeable: true, mode: cfg.mode, partialAtR: v.params.partialAtR, dataSource: ses.source },
        });
        meta.push({ key, tradeable: true, side: t.side, plan: { entry: t.entry, stop: t.stop, target: t.target, targetLabel: "", stopAnchor: "", plannedR: t.plannedR, targets: [] } });
      }
    }
  }

  if (!rows.length) return { logged: 0, tradeable: [], note: "" };
  const ins = await db.from("signals").insert(rows).select("id, key:meta->>key");
  if (ins.error) throw new Error(ins.error.message);
  const idByKey = new Map(((ins.data ?? []) as { id: string; key: string }[]).map((r) => [r.key, r.id]));
  const tradeable = meta.filter((m) => m.tradeable && idByKey.get(m.key)).map((m) => ({ signalId: idByKey.get(m.key)!, side: m.side, plan: { entry: m.plan.entry, stop: m.plan.stop, target: m.plan.target } }));
  const byModel = new Map<string, number>();
  for (const r of rows) byModel.set(String(r.model), (byModel.get(String(r.model)) ?? 0) + 1);
  return { logged: rows.length, tradeable, note: [...byModel.entries()].map(([m, n]) => `${m}×${n}`).join(" ") };
}

/** Keep the live calendar's high-impact releases for later backtests (news filter, model I). */
export async function storeReleases(db: SupabaseClient, calendar: CalEvent[]): Promise<void> {
  const rows = calendar.filter((e) => e.impact === "high" && e.desks.length).map((e) => ({
    at: new Date(e.at).toISOString(), currency: e.currency, title: e.title, impact: "high",
    instruments: e.desks.includes("btc") ? ["XAUUSD", "XAUUSDT.P", "BTCUSDT.P", "BTCUSD", "BTCUSD.SPOT"] : ["XAUUSD", "XAUUSDT.P"],
    forecast: e.forecast, previous: e.previous,
  }));
  if (rows.length) await db.from("news_events").upsert(rows, { onConflict: "at,currency,title", ignoreDuplicates: true });
}
