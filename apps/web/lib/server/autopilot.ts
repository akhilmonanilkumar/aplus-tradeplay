import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ALL_WINDOWS, EDGE_WINDOWS, INSTRUMENTS, TF_MS, analyzeSetup, clientOrderId, costInR, evaluateGate, isFxWeekend, isInWindow, pnlMultiplier, resolveSignal,
  shiftText, sizePosition, stateFromSetup, type Candle, type GateResult, type InstrumentId, type SetupAnalysis,
} from "@aplus/engine";
import { loadCandles, loadHistory } from "@/lib/server/feeds";
import { loadCalendar, type CalEvent } from "@/lib/server/news";
import { chatsFrom, escapeHtml, sendTelegram, type Chat } from "@/lib/server/telegram";
import { runSelector, selectorConfig, type SelectorOutcome } from "@/lib/server/selector";
import { modelLedger, storeReleases } from "@/lib/server/ledger";

/**
 * Autopilot: runs the same detector + A+ gate as the desks on the server, on a schedule.
 * Modes per instrument:
 *   off      nothing
 *   alerts   Telegram on the chosen state changes
 *   paper    alerts + paper orders on ARMED, filled and closed against live candles
 *   confirm  alerts + orders waiting for a one-tap confirm in the app
 *   auto     reserved for live venue adapters; until those ship it behaves like confirm
 * The best-opportunity selector (lib/server/selector.ts) runs after the per-instrument pass
 * on the same evaluations and is configured separately.
 */

export type Mode = "off" | "alerts" | "paper" | "confirm" | "auto";
export interface AutopilotConfig { id: string; instrument: InstrumentId; mode: Mode; account_ids: string[]; risk_pct: number; events: string[]; filters: { allowGradeA?: boolean; windows?: string[]; minRR?: number } }

export interface Evaluation {
  instrument: InstrumentId;
  side: "long" | "short";
  state: ReturnType<typeof stateFromSetup>;
  gate: GateResult | null;
  analysis: SetupAnalysis;
  price: number;
  source: string;
  window: string | null;
  newsClear: boolean;
  ltf: Candle[];
}

const fmt = (x: number, d = 2) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export function newsBlocked(events: CalEvent[], desk: "gold" | "btc", now: number, minutes = 15) {
  return events.some((e) => e.impact === "high" && e.desks.includes(desk) && Math.abs(e.at - now) <= minutes * 60_000);
}

export async function evaluate(id: InstrumentId, opts: { bias?: "long" | "short" | null; calendar: CalEvent[]; filters?: AutopilotConfig["filters"]; settings?: { counter_trend_allowed?: boolean; advanced_models_allowed?: boolean; news_block_minutes?: number } }): Promise<Evaluation> {
  const def = INSTRUMENTS[id];
  const [htf, poi, ltf] = await Promise.all([loadCandles(id, def.htf, 500), loadCandles(id, def.poi, 500), loadCandles(id, def.ltf, 300)]);
  const now = Date.now();
  const allowed = opts.filters?.windows?.length ? ALL_WINDOWS.filter((w) => opts.filters!.windows!.includes(w.id)) : EDGE_WINDOWS;
  const win = allowed.find((w) => isInWindow(now, w)) ?? null;
  const newsClear = !newsBlocked(opts.calendar, def.desk, now, opts.settings?.news_block_minutes ?? 15);
  // Counter-trend pullbacks (Model G, grade A at most) only when both settings allow them.
  const counterTrend = !!(opts.settings?.counter_trend_allowed && opts.settings?.advanced_models_allowed);
  const run = (side: "long" | "short") => {
    const a = analyzeSetup(side, htf.candles, poi.candles, ltf.candles, { now, stopBuffer: def.stopBuffer, minRR: opts.filters?.minRR });
    const against = !!a.htfTrend && a.htfTrend !== (side === "long" ? "up" : "down");
    const model = counterTrend && against ? "G" as const : "A" as const;
    const shifted = !!a.shift?.t || !!a.ltfShift;
    const gate = a.range ? evaluateGate({
      htfTrend: a.htfTrend, poiTfTrend: a.poiTrend, side, price: a.price, range: a.range,
      poi: { inside: !!a.inside, fresh: a.inside?.fresh ?? false, trendAligned: true, liquidityStory: a.inside?.liquidityStory ?? false, createdBos: a.inside?.createdBos ?? true },
      swept: !!a.sweep, shifted, shiftDetail: shiftText(a),
      timing: { inWindow: !!win && !(def.fxHours && isFxWeekend(now)), newsClear, windowId: win?.id ?? null },
      plan: a.suggest ? { ...a.suggest, targetIsStructural: true, stopIsStructural: true } : undefined,
      minStopPct: def.minStopPct, minRR: opts.filters?.minRR, model, instrument: id === "XAUUSDT.P" ? "XAUUSD" : id,
      modelChecks: model === "G" ? { fractal_shift: shifted } : undefined,
      conditions: { ranAway: a.after?.ranAway ?? false },
      config: { counterTrendAllowed: opts.settings?.counter_trend_allowed, advancedModelsAllowed: opts.settings?.advanced_models_allowed },
    }) : null;
    const state = stateFromSetup(a, gate?.verdict === "GO", false);
    return { side, a, gate, state };
  };
  const trendSide = (s: { a: SetupAnalysis }) => (s.a.htfTrend === "up" ? "long" : s.a.htfTrend === "down" ? "short" : null);
  const L = run("long"), S = run("short");
  const order = ["IDLE", "PLANNED", "IN_POI", "SWEPT", "SHIFTED", "ARMED"];
  const want = opts.bias ?? trendSide(L) ?? null;
  const pick = want === "long" ? L : want === "short" ? S : order.indexOf(L.state) >= order.indexOf(S.state) ? L : S;
  return { instrument: id, side: pick.side, state: pick.state, gate: pick.gate, analysis: pick.a, price: pick.a.price, source: ltf.source, window: win?.id ?? null, newsClear, ltf: [...ltf.candles, ...(ltf.forming ? [ltf.forming] : [])] };
}

function stateMessage(e: Evaluation, mode: Mode): string {
  const a = e.analysis, p = a.suggest;
  const icon = e.state === "ARMED" ? (e.side === "long" ? "🟢" : "🔴") : e.state === "SHIFTED" ? "🟡" : "⚪️";
  const head = `${icon} <b>${escapeHtml(e.instrument)} · ${e.state}${e.gate ? ` · ${e.gate.grade.replace("_", " ")}` : ""}</b>`;
  const lines = [head];
  if (e.state === "ARMED" && p && e.gate) {
    lines.push(`${e.side === "long" ? "Long" : "Short"} limit ${fmt(p.entry)} · SL ${fmt(p.stop)} (${escapeHtml(p.stopAnchor)}) · TP ${fmt(p.target)} (${escapeHtml(p.targetLabel)}) · ${fmt(e.gate.rr ?? 0)}R`);
    lines.push(`Model A · ${e.window === "london_q" ? "London Q" : e.window === "ny_q" ? "NY Q" : "—"} · ${mode === "paper" ? "paper" : mode === "alerts" ? "alert only" : "confirm in app"}`);
  } else if (e.state === "SHIFTED" && a.shift) {
    lines.push(`5M body close ${fmt(a.shift.close ?? 0)} through ${fmt(a.shift.level)}${e.gate?.waitingFor.length ? ` · waiting: ${escapeHtml(e.gate.waitingFor.slice(0, 2).join(", "))}` : ""}`);
  } else if (e.state === "SWEPT" && a.sweep) {
    lines.push(`${escapeHtml(a.sweep.label)} ${fmt(a.sweep.level)} swept (wick ${fmt(a.sweep.wick)}) · watching for the 5M shift`);
  } else if (e.state === "IN_POI" && a.inside) {
    lines.push(`Price in ${escapeHtml(a.inside.label)} ${fmt(a.inside.bottom)}–${fmt(a.inside.top)}`);
  }
  if (e.gate?.blockers.length) lines.push(`Blocked: ${escapeHtml(e.gate.blockers.join(", "))}`);
  lines.push(`<i>${escapeHtml(e.source)} · ${fmt(e.price)}</i>`);
  return lines.join("\n");
}

/** Settings, chats and a per-pass evaluation memo shared by the instrument loop and the selector. */
async function passContext(db: SupabaseClient) {
  const [cfgRes, setRes, calendar] = await Promise.all([
    db.from("autopilot_config").select("*"),
    db.from("app_settings").select("*").eq("id", 1).single(),
    loadCalendar().catch(() => ({ items: [] as CalEvent[] })),
  ]);
  if (cfgRes.error) throw new Error(cfgRes.error.message);
  const settings = setRes.data as { kill_switch: boolean; mode: string; integrations?: { telegram_chats?: Chat[]; selector?: unknown }; counter_trend_allowed?: boolean; advanced_models_allowed?: boolean; news_block_minutes?: number } | null;
  const chats = chatsFrom(settings?.integrations?.telegram_chats);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  // One evaluation per instrument and filter set per pass; the selector reuses the per-instrument ones.
  const memo = new Map<string, Promise<Evaluation>>();
  const evalFor = (id: InstrumentId, filters?: AutopilotConfig["filters"]) => {
    const k = `${id}:${JSON.stringify({ w: filters?.windows ?? null, rr: filters?.minRR ?? null })}`;
    if (!memo.has(k)) {
      memo.set(k, (async () => {
        const bias = await db.from("bias_reports").select("allowed").eq("instrument", id).eq("report_date", today).maybeSingle();
        return evaluate(id, { bias: (bias.data?.allowed as "long" | "short" | null) ?? null, calendar: calendar.items, filters, settings: settings ?? undefined });
      })());
    }
    return memo.get(k)!;
  };
  return { configs: (cfgRes.data ?? []) as AutopilotConfig[], settings, chats, evalFor, calendar: calendar.items };
}

/** Score the selector board without acting: no signals, orders, Telegram or log rows. */
export async function previewSelector(db: SupabaseClient): Promise<SelectorOutcome> {
  const { settings, chats, evalFor } = await passContext(db);
  const cfg = selectorConfig(settings?.integrations?.selector);
  return runSelector(db, { config: { ...cfg, enabled: true }, evalFor: (id) => evalFor(id), chats, killSwitch: true, dryRun: true });
}

/** One autopilot pass over every enabled instrument. Idempotent: only state changes act. */
export async function tick(db: SupabaseClient): Promise<{ results: { instrument: string; state: string; action: string }[]; selector: SelectorOutcome | null }> {
  const { configs, settings, chats, evalFor, calendar } = await passContext(db);
  const out: { instrument: string; state: string; action: string }[] = [];
  await storeReleases(db, calendar).catch(() => undefined);

  for (const cfg of configs) {
    if (cfg.mode === "off") {
      // Still fill and close manual paper orders from the desks.
      try {
        const pending = await db.from("orders").select("id, signals!inner(instrument)", { count: "exact", head: true }).eq("action", "PAPER").eq("status", "queued").eq("signals.instrument", cfg.instrument);
        const open = await db.from("trades").select("id", { count: "exact", head: true }).eq("instrument", cfg.instrument).eq("source", "paper").is("exit", null);
        if ((pending.count ?? 0) + (open.count ?? 0) > 0) {
          const c = await loadCandles(cfg.instrument, INSTRUMENTS[cfg.instrument].ltf, 300);
          const paper = await managePaper(db, cfg, [...c.candles, ...(c.forming ? [c.forming] : [])], chats);
          out.push({ instrument: cfg.instrument, state: "OFF", action: paper || "none" });
        }
      } catch (err) {
        out.push({ instrument: cfg.instrument, state: "ERROR", action: (err as Error).message });
      }
      continue;
    }
    try {
      const e = await evalFor(cfg.instrument, cfg.filters);
      const last = await db.from("autopilot_runs").select("state, side, detail").eq("instrument", cfg.instrument).order("at", { ascending: false }).limit(1).maybeSingle();
      const planKey = e.analysis.suggest ? `${e.analysis.suggest.entry}:${e.analysis.suggest.stop}:${e.analysis.suggest.target}` : null;
      const prev = last.data as { state: string; side: string; detail: { plan?: string | null } } | null;
      const changed = !prev || prev.state !== e.state || prev.side !== e.side || (e.state === "ARMED" && prev.detail?.plan !== planKey);
      let action = "none";

      if (changed) {
        const allowA = cfg.filters?.allowGradeA === true;
        const tradeable = e.state === "ARMED" || (allowA && e.gate?.grade === "A" && !e.gate.blockers.length && e.gate.boxes.every((b) => b.status === "pass" || b.status === "warn"));
        // Signals and paper orders come from the model ledger below; this block keeps the state log and alerts.
        const signalId: string | null = null;
        if (cfg.events.includes(e.state) || (tradeable && cfg.events.includes("ARMED"))) {
          await sendTelegram(db, { text: stateMessage(e, cfg.mode), chats, kind: e.state, instrument: cfg.instrument, signalId, source: "autopilot" });
          if (action === "none") action = "alert";
        }
        await db.from("autopilot_runs").insert({
          instrument: cfg.instrument, side: e.side, state: e.state, grade: e.gate?.grade ?? null, verdict: e.gate?.verdict ?? null, price: e.price, action,
          detail: { plan: planKey, source: e.source, window: e.window, newsClear: e.newsClear, waitingFor: e.gate?.waitingFor ?? [], blockers: e.gate?.blockers ?? [], suggest: e.analysis.suggest },
        });
      }
      // Every entry model and session strategy: logged once per setup, paper orders for the ones the gate would trade.
      let ledger = "";
      try {
        const l = await modelLedger(db, cfg, { calendar, settings });
        let orders = 0;
        if (l.tradeable.length && (cfg.mode === "paper" || cfg.mode === "confirm" || cfg.mode === "auto") && !settings?.kill_switch) {
          for (const t of l.tradeable) { const q = await queue(db, cfg, t.side, t.plan, t.signalId); if (/^\d+ /.test(q)) orders += Number(q.split(" ")[0]); }
        }
        if (l.logged) ledger = `logged ${l.logged} (${l.note})${orders ? ` · ${orders} paper orders` : ""}`;
      } catch (err) {
        ledger = `ledger error: ${(err as Error).message}`;
      }
      const paper = await managePaper(db, cfg, e.ltf, chats);
      out.push({ instrument: cfg.instrument, state: e.state, action: [action, ledger, paper].filter((x) => x && x !== "none").join(" · ") || "none" });
    } catch (err) {
      await db.from("autopilot_runs").insert({ instrument: cfg.instrument, state: "ERROR", action: "error", detail: { error: (err as Error).message } });
      out.push({ instrument: cfg.instrument, state: "ERROR", action: (err as Error).message });
    }
  }

  const sel = selectorConfig(settings?.integrations?.selector);
  let selector: SelectorOutcome | null = null;
  if (sel.enabled && sel.universe.length) {
    try {
      selector = await runSelector(db, { config: sel, evalFor: (id) => evalFor(id), chats, killSwitch: !!settings?.kill_switch });
    } catch (err) {
      await db.from("autopilot_runs").insert({ instrument: "SELECTOR", state: "ERROR", action: "error", detail: { error: (err as Error).message } });
      out.push({ instrument: "SELECTOR", state: "ERROR", action: (err as Error).message });
    }
  }

  try {
    const n = await trackSignals(db);
    if (n) out.push({ instrument: "LEDGER", state: "TRACKED", action: `${n} signal outcome${n === 1 ? "" : "s"} updated` });
  } catch (err) {
    out.push({ instrument: "LEDGER", state: "ERROR", action: (err as Error).message });
  }
  return { results: out, selector };
}

/**
 * Bot ledger: resolve every open autopilot/selector signal against its entry-TF candles
 * (fill, ran away, expired, then stop or target), independent of any account.
 */
async function trackSignals(db: SupabaseClient): Promise<number> {
  const open = await db.from("signals").select("id, instrument, side, entry, stop, target, created_at, outcome, entry_type:meta->>entryType")
    .in("source", ["autopilot", "selector"]).in("outcome", ["pending", "filled"])
    .gte("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString()).order("created_at").limit(1000);
  if (open.error) throw new Error(open.error.message);
  let updated = 0;
  const byInst = new Map<InstrumentId, typeof open.data>();
  for (const s of open.data ?? []) {
    if (!(s.instrument in INSTRUMENTS)) continue;
    byInst.set(s.instrument as InstrumentId, [...(byInst.get(s.instrument as InstrumentId) ?? []), s]);
  }
  for (const [id, list] of byInst) {
    const def = INSTRUMENTS[id];
    const tfMs = TF_MS[def.ltf];
    const oldest = Math.min(...list.map((s) => Date.parse(s.created_at)));
    let candles = (await loadCandles(id, def.ltf, 300)).candles;
    if (!candles.length || candles[0]!.t > oldest - tfMs) candles = (await loadHistory(id, def.ltf, oldest - tfMs, Date.now(), { allowMetered: true })).candles;
    for (const s of list) {
      const plan = { side: s.side as "long" | "short", entry: Number(s.entry), stop: Number(s.stop), target: Number(s.target), createdAt: Date.parse(s.created_at), market: s.entry_type === "market" };
      const r = resolveSignal(plan, candles, tfMs);
      if (r.outcome === s.outcome) continue;
      const cost = r.resultR !== null ? costInR(def, plan.entry, plan.stop) : 0;
      const upd = await db.from("signals").update({
        outcome: r.outcome,
        filled_at: r.filledAt ? new Date(r.filledAt).toISOString() : null,
        closed_at: r.closedAt ? new Date(r.closedAt).toISOString() : null,
        exit_price: r.exit,
        result_r: r.resultR,
        net_r: r.resultR !== null ? Number((r.resultR - cost).toFixed(3)) : null,
      }).eq("id", s.id).eq("outcome", s.outcome);
      if (!upd.error) updated++;
    }
  }
  return updated;
}

async function queue(db: SupabaseClient, cfg: AutopilotConfig, side: "long" | "short", p: { entry: number; stop: number; target: number }, signalId: string): Promise<string> {
  if (!cfg.account_ids.length) return "signal only (no accounts assigned)";
  const def = INSTRUMENTS[cfg.instrument];
  const acc = await db.from("trading_accounts").select("id, name, balance, equity, risk_pct, active").in("id", cfg.account_ids);
  const rows = (acc.data ?? []).filter((a) => a.active).map((a) => {
    const s = sizePosition(def, { balance: Number(a.equity) || Number(a.balance), riskPct: Number(cfg.risk_pct) || Number(a.risk_pct), entry: p.entry, stop: p.stop });
    const action = s.belowMinimum ? "BLOCK" : cfg.mode === "paper" ? "PAPER" : "CONFIRM";
    return {
      signal_id: signalId, account_id: a.id, client_order_id: clientOrderId(signalId, a.id), action, side, qty: s.size,
      entry: p.entry, stop: p.stop, target: p.target, risk_amount: s.riskAmount,
      reasons: s.belowMinimum ? ["below minimum size after rounding"] : cfg.mode === "auto" ? ["live adapters pending — confirm manually"] : [],
      status: action === "BLOCK" ? "blocked" : action === "PAPER" ? "queued" : "awaiting_confirm",
    };
  });
  if (!rows.length) return "no active accounts";
  const { error } = await db.from("orders").upsert(rows, { onConflict: "client_order_id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return `${rows.filter((r) => r.action !== "BLOCK").length} ${cfg.mode === "paper" ? "paper" : "confirm"} orders`;
}

/** Fill, expire and close paper orders/trades for one instrument against its entry-TF candles. */
async function managePaper(db: SupabaseClient, cfg: AutopilotConfig, ltf: Candle[], chats: Chat[]): Promise<string> {
  const def = INSTRUMENTS[cfg.instrument];
  const tfMs = TF_MS[def.ltf];
  const notes: string[] = [];
  const pend = await db.from("orders").select("*, signals!inner(instrument, model, session_window, rr, grade, source, created_at, meta)").eq("action", "PAPER").eq("status", "queued").eq("signals.instrument", cfg.instrument);
  const filledSignals = new Set<string>();
  for (const o of pend.data ?? []) {
    // Orders work from the signal's bar close; market entries (model E, session strategies) fill there.
    const created = Date.parse(o.signals.created_at ?? o.created_at);
    const bars = ltf.filter((c) => c.t + tfMs > created);
    const long = o.side === "long";
    const market = (o.signals.meta as { entryType?: string } | null)?.entryType === "market";
    const fillBar = market ? { t: created } : bars.find((c) => (long ? c.l <= o.entry : c.h >= o.entry));
    const ranAway = bars.find((c) => (long ? c.h >= o.target : c.l <= o.target));
    if (fillBar && (!ranAway || fillBar.t <= ranAway.t)) {
      const upd = await db.from("orders").update({ status: "filled", fill_price: o.entry, filled_at: new Date(Math.max(fillBar.t, created)).toISOString() }).eq("id", o.id).eq("status", "queued").select("id");
      if (!upd.data?.length) continue;
      await db.from("trades").insert({
        account_id: o.account_id, signal_id: o.signal_id, instrument: cfg.instrument, side: o.side, model: o.signals.model, session_window: o.signals.session_window,
        qty: o.qty, entry: o.entry, stop: o.stop, target: o.target, planned_r: o.signals.rr, grade: o.signals.grade === "A" ? "A" : "A+", source: "paper", risk_pct: cfg.risk_pct,
        opened_at: new Date(Math.max(fillBar.t, created)).toISOString(),
      });
      if (o.signals.source === "selector" && o.signal_id && !filledSignals.has(o.signal_id)) {
        filledSignals.add(o.signal_id);
        await sendTelegram(db, { text: `📥 <b>${escapeHtml(cfg.instrument)} filled</b>\n${long ? "Long" : "Short"} ${fmt(Number(o.entry))} · SL ${fmt(Number(o.stop))} · TP ${fmt(Number(o.target))} · paper`, chats, kind: "FILLED", instrument: cfg.instrument, signalId: o.signal_id, source: "autopilot" });
      }
      notes.push("paper fill");
    } else if (ranAway || bars.length >= 12) {
      await db.from("orders").update({ status: "cancelled", reasons: [...(o.reasons ?? []), ranAway ? "ran away before fill" : "expired"] }).eq("id", o.id).eq("status", "queued");
      notes.push("paper cancel");
    }
  }
  const open = await db.from("trades").select("*, signals(source)").eq("instrument", cfg.instrument).eq("source", "paper").is("exit", null);
  for (const t of open.data ?? []) {
    const opened = Date.parse(t.opened_at);
    const long = t.side === "long";
    for (const c of ltf.filter((x) => x.t >= opened - tfMs + 1)) {
      const hitStop = long ? c.l <= t.stop : c.h >= t.stop;
      const hitTarget = t.target !== null && (long ? c.h >= t.target : c.l <= t.target);
      if (!hitStop && !hitTarget) continue;
      const exit = hitStop ? Number(t.stop) : Number(t.target);
      const risk = Math.abs(t.entry - t.stop);
      const mult = pnlMultiplier(cfg.instrument);
      const gross = (long ? exit - t.entry : t.entry - exit) * t.qty * mult;
      const fees = def.costRate * t.entry * t.qty * mult;
      const r = ((long ? 1 : -1) * (exit - t.entry)) / risk;
      const upd = await db.from("trades").update({ exit, closed_at: new Date(c.t + tfMs).toISOString(), realized_r: Number(r.toFixed(3)), pnl: Number((gross - fees).toFixed(2)), fees: Number(fees.toFixed(4)) }).eq("id", t.id).is("exit", null).select("id");
      if (upd.data?.length) {
        const acc = await db.from("trading_accounts").select("balance, equity, is_live, name").eq("id", t.account_id).single();
        if (acc.data && !acc.data.is_live) {
          await db.from("trading_accounts").update({ balance: Number(acc.data.balance) + gross - fees, equity: Number(acc.data.equity) + gross - fees }).eq("id", t.account_id);
        }
        if (cfg.events.includes("CLOSED") || (t.signals as { source?: string } | null)?.source === "selector") {
          await sendTelegram(db, { text: `${r > 0 ? "✅" : "❌"} <b>${escapeHtml(cfg.instrument)} closed ${r > 0 ? "+" : ""}${r.toFixed(2)}R</b>\n${long ? "Long" : "Short"} ${fmt(Number(t.entry))} → ${fmt(exit)} · ${escapeHtml(acc.data?.name ?? "")} · paper`, chats, kind: "CLOSED", instrument: cfg.instrument, signalId: t.signal_id, source: "autopilot" });
        }
        notes.push(`closed ${r.toFixed(2)}R`);
      }
      break;
    }
  }
  return notes.join(", ");
}
