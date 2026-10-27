import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SELECTOR, INSTRUMENTS, TF_MS, liveDesk, clientOrderId, runBacktest, usHighImpactTimes, selectOpportunities, sizePosition,
  type Candidate, type DeskId, type InstrumentId, type Scored, type Tf,
} from "@aplus/engine";
import { confluence } from "@/lib/confluence";
import { loadDerivs, type Derivs } from "@/lib/server/derivs";
import { historyEnd, loadFrames } from "@/lib/server/feeds";
import { loadMacro, type Macro } from "@/lib/server/macro";
import { telegramExecutor, type TradeTicket } from "@/lib/server/execution";
import type { Chat } from "@/lib/server/telegram";
import type { Evaluation } from "@/lib/server/autopilot";
import type { SelectorConfig } from "@/lib/selectorConfig";

export { selectorConfig, DEFAULT_SELECTOR_CONFIG, type SelectorConfig } from "@/lib/selectorConfig";

/**
 * Best-opportunity selector. Every pass it scores each live setup across both desks
 * (A+ gate, R:R, confluence, recent edge, timing), picks the best trade per underlying,
 * and sends it out as one trade ticket. It only ranks setups the gate already passes.
 * Settings live in app_settings.integrations.selector (see lib/selectorConfig.ts).
 */

/* ---------------- recent edge ---------------- */

export interface Edge { avgR: number; n: number; winRate: number; at: string }

const EDGE_DAYS = 21;
const EDGE_TTL = 20 * 3_600_000;
const WARM: Partial<Record<Tf, number>> = { "1h": 32 * 86_400_000, "4h": 90 * 86_400_000, "15m": 8 * 86_400_000, "5m": 2 * 86_400_000 };

/**
 * Walk-forward result of the edge on the last three weeks, per instrument, refreshed about daily.
 * At most `refresh` instruments are recomputed per call so a pass stays fast and within vendor limits.
 */
export async function recentEdges(db: SupabaseClient, ids: InstrumentId[], opts: { allowGradeA: boolean; refresh?: number }): Promise<Map<InstrumentId, Edge>> {
  const out = new Map<InstrumentId, Edge>();
  const refresh = opts.refresh ?? 1;
  // Measured with the same grade rule the selector trades, so the edge describes what it would take.
  const rows = await db.from("backtests").select("instrument, created_at, stats").is("strategy_id", null).eq("summary->>kind", "edge")
    .eq("summary->>allowGradeA", String(opts.allowGradeA)).in("instrument", ids).order("created_at", { ascending: false }).limit(100);
  for (const r of rows.data ?? []) {
    const id = r.instrument as InstrumentId;
    if (out.has(id)) continue;
    const s = r.stats as { avgR: number; n: number; winRate: number };
    out.set(id, { avgR: s.avgR, n: s.n, winRate: s.winRate, at: r.created_at as string });
  }
  const stale = ids.filter((id) => !out.has(id) || Date.now() - Date.parse(out.get(id)!.at) > EDGE_TTL)
    .sort((a, b) => (out.has(a) ? Date.parse(out.get(a)!.at) : 0) - (out.has(b) ? Date.parse(out.get(b)!.at) : 0));
  for (const id of stale.slice(0, refresh)) {
    try {
      const def = INSTRUMENTS[id];
      const to = historyEnd();
      const from = to - EDGE_DAYS * 86_400_000;
      const [ltf, htf, poi] = await loadFrames(id, [def.ltf, def.htf, def.poi].map((tf) => ({ tf, from: from - (WARM[tf] ?? 0) })), to);
      const res = runBacktest(id, { htf: htf.candles, poi: poi.candles, ltf: ltf.candles, news: usHighImpactTimes(from - 7 * 86_400_000, to) }, { allowGradeA: opts.allowGradeA });
      const at = new Date().toISOString();
      await db.from("backtests").insert({
        strategy_id: null, instrument: id, from_ts: new Date(res.from).toISOString(), to_ts: new Date(res.to).toISOString(),
        params: res.params, stats: res.stats, summary: { kind: "edge", allowGradeA: opts.allowGradeA, days: EDGE_DAYS, returnPct: res.returnPct, maxDrawdownPct: res.maxDrawdownPct, signals: res.signals, rejected: res.rejected, cancelled: res.cancelled, bars: res.bars },
        trades: [], source: ltf.source,
      });
      out.set(id, { avgR: res.stats.avgR, n: res.stats.n, winRate: res.stats.winRate, at });
    } catch {
      // Keep the previous figure; the score treats a missing edge as neutral.
    }
  }
  return out;
}

/* ---------------- selection pass ---------------- */

export interface SelectorOutcome {
  picks: { instrument: InstrumentId; side: string; score: number; action: string }[];
  ranked: { instrument: InstrumentId; side: string; state: string; score: number; eligible: boolean; reasons: string[] }[];
  edges?: Record<string, Edge>;
  busy?: DeskId[];
}

const istMidnight = () => Date.parse(`${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}T00:00:00+05:30`);
const windowName = (w: string | null) => (w === "london_q" ? "London Q" : w === "ny_q" ? "NY Q" : w === "asia_q" ? "Asia Q" : w === "london_close" ? "London close" : "outside killzone");

function why(s: Scored, edge: Edge | undefined): string[] {
  const out = [s.verdict === "GO" ? "A+ 7/7" : "grade A"];
  if (s.context !== null) out.push(`context ${s.context >= 0 ? "+" : ""}${s.context}`);
  out.push(edge && edge.n ? `edge ${edge.avgR >= 0 ? "+" : ""}${edge.avgR.toFixed(2)}R over ${edge.n} (${EDGE_DAYS}d)` : "edge: few recent trades");
  out.push(windowName(s.window));
  if (s.caution.length) out.push(`caution: ${s.caution.join(", ")}`);
  return out;
}

function gateReason(e: Evaluation): string | null {
  const g = e.gate;
  if (!g) return e.analysis.range ? null : "no HTF range yet";
  const failed = g.boxes.find((b) => b.status === "fail");
  return g.blockers[0] ?? (failed ? `${failed.label} — ${failed.reason}` : null) ?? g.waitingFor[0] ?? null;
}

/** Desks with a selector trade still pending/open, or picked within the cooldown. */
async function busyDesks(db: SupabaseClient, cooldownMin: number): Promise<Set<DeskId>> {
  const desk = (i: string) => INSTRUMENTS[i as InstrumentId]?.desk;
  const since = new Date(Date.now() - cooldownMin * 60_000).toISOString();
  const [recent, orders, trades] = await Promise.all([
    db.from("signals").select("instrument").eq("source", "selector").gte("created_at", since),
    db.from("orders").select("id, signals!inner(instrument, source)").in("status", ["queued", "awaiting_confirm"]).eq("signals.source", "selector"),
    db.from("trades").select("instrument, signals!inner(source)").is("exit", null).eq("signals.source", "selector"),
  ]);
  const out = new Set<DeskId>();
  for (const r of recent.data ?? []) if (desk(r.instrument)) out.add(desk(r.instrument)!);
  for (const r of (orders.data ?? []) as unknown as { signals: { instrument: string } }[]) if (desk(r.signals.instrument)) out.add(desk(r.signals.instrument)!);
  for (const r of trades.data ?? []) if (desk(r.instrument)) out.add(desk(r.instrument)!);
  return out;
}

export async function runSelector(db: SupabaseClient, deps: {
  config: SelectorConfig;
  evalFor: (id: InstrumentId) => Promise<Evaluation>;
  chats: Chat[];
  killSwitch: boolean;
  /** Score and return the board only: nothing is written or sent (the edge cache still refreshes). */
  dryRun?: boolean;
}): Promise<SelectorOutcome> {
  const cfg = deps.config;
  const ids = cfg.universe;
  const desks = [...new Set(ids.map((i) => liveDesk(i)))];
  const [evals, edges, ctx] = await Promise.all([
    Promise.allSettled(ids.map((i) => deps.evalFor(i))),
    recentEdges(db, ids, { allowGradeA: cfg.allowGradeA }).catch(() => new Map<InstrumentId, Edge>()),
    Promise.all(desks.map(async (d) => {
      const [dv, mc] = await Promise.all([
        loadDerivs(d === "gold" ? "XAUUSDT" : "BTCUSDT").catch(() => null as Derivs | null),
        loadMacro(d).catch(() => null as Macro | null),
      ]);
      return [d, { dv, mc }] as const;
    })).then((x) => new Map(x)),
  ]);

  const byId = new Map<InstrumentId, Evaluation>();
  const candidates: Candidate[] = [];
  evals.forEach((r, k) => {
    if (r.status !== "fulfilled") return;
    const e = r.value, def = INSTRUMENTS[ids[k]!];
    byId.set(e.instrument, e);
    const c = ctx.get(liveDesk(def.id));
    const conf = confluence(liveDesk(def.id), e.side, c?.dv, c?.mc);
    const p = e.analysis.suggest;
    const edge = edges.get(e.instrument);
    candidates.push({
      instrument: e.instrument, side: e.side, state: e.state, grade: e.gate?.grade ?? null, verdict: e.gate?.verdict ?? null,
      blockers: e.gate?.blockers ?? [], rr: e.gate?.rr ?? null, entry: p?.entry ?? null, stop: p?.stop ?? null, target: p?.target ?? null,
      price: e.price, window: e.window, context: c?.dv || c?.mc ? conf.score : null, caution: conf.caution,
      edge: edge ? { avgR: edge.avgR, n: edge.n, winRate: edge.winRate } : null,
      gateReason: gateReason(e),
    });
  });

  const [busy, today] = await Promise.all([
    busyDesks(db, cfg.cooldownMin),
    db.from("signals").select("id", { count: "exact", head: true }).eq("source", "selector").gte("created_at", new Date(istMidnight()).toISOString()),
  ]);
  const { picks, ranked } = selectOpportunities(candidates, {
    params: { ...DEFAULT_SELECTOR, minScore: cfg.minScore, allowGradeA: cfg.allowGradeA },
    busyDesks: busy,
    slots: Math.max(0, cfg.maxPerDay - (today.count ?? 0)),
  });

  const outcome: SelectorOutcome = {
    picks: [],
    ranked: ranked.map((s) => ({ instrument: s.instrument, side: s.side, state: s.state, score: s.score, eligible: s.eligible, reasons: s.reasons })),
  };
  const pickDetail: Record<string, unknown>[] = [];

  if (deps.dryRun) {
    outcome.picks = picks.map((s) => ({ instrument: s.instrument, side: s.side, score: s.score, action: "preview" }));
    return { ...outcome, edges: Object.fromEntries(edges), busy: [...busy] };
  }

  for (const s of picks) {
    const e = byId.get(s.instrument)!;
    const p = e.analysis.suggest!;
    const def = INSTRUMENTS[s.instrument];
    const sig = await db.from("signals").insert({
      instrument: s.instrument, side: s.side, model: "A", session_window: s.window, entry: p.entry, stop: p.stop, target: p.target,
      rr: s.rr, grade: s.grade, gate: e.gate?.boxes ?? [], state: "ARMED", edge_version: "3.0", source: "selector",
      outcome: "pending", meta: { score: s.score, parts: s.parts, context: s.context, edge: s.edge, why: why(s, edges.get(s.instrument)), targetLabel: p.targetLabel, dataSource: e.source },
    }).select("id").single();
    if (sig.error) { outcome.picks.push({ instrument: s.instrument, side: s.side, score: s.score, action: `error: ${sig.error.message}` }); continue; }
    const signalId = sig.data.id as string;

    const accs = cfg.account_ids.length
      ? ((await db.from("trading_accounts").select("id, name, balance, equity, active, instruments").in("id", cfg.account_ids)).data ?? [])
      : [];
    const sized = accs.filter((a) => a.active && (!a.instruments?.length || a.instruments.includes(s.instrument))).map((a) => {
      const z = sizePosition(def, { balance: Number(a.equity) || Number(a.balance), riskPct: cfg.riskPct, entry: p.entry, stop: p.stop });
      return { accountId: a.id as string, name: a.name as string, qty: z.size, unit: z.unit, riskAmount: z.riskAmount, blocked: z.belowMinimum ? "below minimum size" : null };
    });
    const paper = cfg.paper && !deps.killSwitch && sized.some((a) => !a.blocked);
    if (paper) {
      await db.from("orders").upsert(sized.map((a) => ({
        signal_id: signalId, account_id: a.accountId, client_order_id: clientOrderId(signalId, a.accountId), action: a.blocked ? "BLOCK" : "PAPER", side: s.side,
        qty: a.qty, entry: p.entry, stop: p.stop, target: p.target, risk_amount: a.riskAmount, reasons: a.blocked ? [a.blocked] : ["selector pick"],
        status: a.blocked ? "blocked" : "queued",
      })), { onConflict: "client_order_id", ignoreDuplicates: true });
    }

    const ticket: TradeTicket = {
      signalId, instrument: s.instrument, side: s.side, orderType: "limit", entry: p.entry, stop: p.stop, target: p.target, targetLabel: p.targetLabel,
      rr: s.rr ?? 0, expiresAt: Date.now() + 12 * TF_MS[def.ltf], score: s.score, why: why(s, edges.get(s.instrument)),
      alternatives: ranked.filter((r) => r !== s && r.state !== "IDLE").slice(0, 3).map((r) => `${r.instrument} ${r.side} ${r.score}${r.reasons[0] ? ` (${r.reasons[0]})` : ""}`),
      accounts: sized, paper, source: e.source,
    };
    const sent = await telegramExecutor(db, deps.chats).submit(ticket);
    const action = [sent.ok ? "telegram sent" : `telegram failed: ${sent.error}`, paper ? `${sized.filter((a) => !a.blocked).length} paper orders` : deps.killSwitch ? "kill switch: no orders" : null].filter(Boolean).join(" · ");
    outcome.picks.push({ instrument: s.instrument, side: s.side, score: s.score, action });
    pickDetail.push({ signalId, instrument: s.instrument, side: s.side, score: s.score, parts: s.parts, why: ticket.why, plan: { entry: p.entry, stop: p.stop, target: p.target, rr: s.rr }, action });
  }

  // One log row per pass under "SELECTOR" (never under the instrument, whose rows drive the per-instrument
  // state machine). Written on a pick, or when the board changes.
  const key = outcome.ranked.map((r) => `${r.instrument}:${r.side}:${r.state}:${r.eligible ? 1 : 0}:${Math.round(r.score / 5)}`).join("|");
  const last = await db.from("autopilot_runs").select("detail").eq("instrument", "SELECTOR").order("at", { ascending: false }).limit(1).maybeSingle();
  if ((last.data?.detail as { key?: string } | null)?.key !== key || outcome.picks.length) {
    const top = picks[0];
    await db.from("autopilot_runs").insert({
      instrument: "SELECTOR", side: top?.side ?? null, state: picks.length ? "PICK" : "SCAN", grade: top?.grade ?? null, verdict: top?.verdict ?? null, price: top?.price ?? null,
      action: outcome.picks.length ? outcome.picks.map((x) => `${x.instrument} ${x.side} ${x.score}/100 · ${x.action}`).join(" | ") : "no trade",
      detail: { key, picks: pickDetail, ranked: outcome.ranked, edges: Object.fromEntries(edges), busy: [...busy] },
    });
  }
  return outcome;
}
