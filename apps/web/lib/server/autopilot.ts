import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ALL_WINDOWS, EDGE_WINDOWS, INSTRUMENTS, TF_MS, analyzeSetup, clientOrderId, evaluateGate, isFxWeekend, isInWindow, pnlMultiplier,
  sizePosition, stateFromSetup, type Candle, type GateResult, type InstrumentId, type SetupAnalysis,
} from "@aplus/engine";
import { loadCandles } from "@/lib/server/feeds";
import { loadCalendar, type CalEvent } from "@/lib/server/news";
import { chatsFrom, escapeHtml, sendTelegram, type Chat } from "@/lib/server/telegram";

/**
 * Autopilot: runs the same detector + A+ gate as the desks on the server, on a schedule.
 * Modes per instrument:
 *   off      nothing
 *   alerts   Telegram on the chosen state changes
 *   paper    alerts + paper orders on ARMED, filled and closed against live candles
 *   confirm  alerts + orders waiting for a one-tap confirm in the app
 *   auto     reserved for live venue adapters; until those ship it behaves like confirm
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
  const [htf, poi, ltf] = await Promise.all([loadCandles(id, def.htf, 300), loadCandles(id, def.poi, 400), loadCandles(id, def.ltf, 300)]);
  const now = Date.now();
  const allowed = opts.filters?.windows?.length ? ALL_WINDOWS.filter((w) => opts.filters!.windows!.includes(w.id)) : EDGE_WINDOWS;
  const win = allowed.find((w) => isInWindow(now, w)) ?? null;
  const newsClear = !newsBlocked(opts.calendar, def.desk, now, opts.settings?.news_block_minutes ?? 15);
  const run = (side: "long" | "short") => {
    const a = analyzeSetup(side, htf.candles, poi.candles, ltf.candles, { now, stopBuffer: def.stopBuffer });
    const gate = a.range ? evaluateGate({
      htfTrend: a.htfTrend, poiTfTrend: a.poiTrend, side, price: a.price, range: a.range,
      poi: { inside: !!a.inside, fresh: a.inside?.fresh ?? false, trendAligned: true, liquidityStory: a.inside?.liquidityStory ?? false, createdBos: a.inside?.createdBos ?? true },
      swept: !!a.sweep, shifted: !!a.shift?.t,
      timing: { inWindow: !!win && !(def.fxHours && isFxWeekend(now)), newsClear, windowId: win?.id ?? null },
      plan: a.suggest ? { ...a.suggest, targetIsStructural: true, stopIsStructural: true } : undefined,
      minStopPct: def.minStopPct, minRR: opts.filters?.minRR, model: "A", instrument: id === "XAUUSDT.P" ? "XAUUSD" : id,
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
    lines.push(`${e.side === "long" ? "Long" : "Short"} limit ${fmt(p.entry)} · SL ${fmt(p.stop)} · TP ${fmt(p.target)} (${escapeHtml(p.targetLabel)}) · ${fmt(e.gate.rr ?? 0)}R`);
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

/** One autopilot pass over every enabled instrument. Idempotent: only state changes act. */
export async function tick(db: SupabaseClient): Promise<{ instrument: string; state: string; action: string }[]> {
  const [cfgRes, setRes, calendar] = await Promise.all([
    db.from("autopilot_config").select("*"),
    db.from("app_settings").select("*").eq("id", 1).single(),
    loadCalendar().catch(() => ({ items: [] as CalEvent[] })),
  ]);
  if (cfgRes.error) throw new Error(cfgRes.error.message);
  const settings = setRes.data as { kill_switch: boolean; mode: string; integrations?: { telegram_chats?: Chat[] }; counter_trend_allowed?: boolean; advanced_models_allowed?: boolean; news_block_minutes?: number } | null;
  const chats = chatsFrom(settings?.integrations?.telegram_chats);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const out: { instrument: string; state: string; action: string }[] = [];

  for (const cfg of (cfgRes.data ?? []) as AutopilotConfig[]) {
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
      const bias = await db.from("bias_reports").select("allowed").eq("instrument", cfg.instrument).eq("report_date", today).maybeSingle();
      const e = await evaluate(cfg.instrument, { bias: (bias.data?.allowed as "long" | "short" | null) ?? null, calendar: calendar.items, filters: cfg.filters, settings: settings ?? undefined });
      const last = await db.from("autopilot_runs").select("state, side, detail").eq("instrument", cfg.instrument).order("at", { ascending: false }).limit(1).maybeSingle();
      const planKey = e.analysis.suggest ? `${e.analysis.suggest.entry}:${e.analysis.suggest.stop}:${e.analysis.suggest.target}` : null;
      const prev = last.data as { state: string; side: string; detail: { plan?: string | null } } | null;
      const changed = !prev || prev.state !== e.state || prev.side !== e.side || (e.state === "ARMED" && prev.detail?.plan !== planKey);
      let action = "none";

      if (changed) {
        const allowA = cfg.filters?.allowGradeA === true;
        const tradeable = e.state === "ARMED" || (allowA && e.gate?.grade === "A" && !e.gate.blockers.length && e.gate.boxes.every((b) => b.status === "pass" || b.status === "warn"));
        let signalId: string | null = null;
        if (tradeable && e.analysis.suggest && e.gate && (cfg.mode === "paper" || cfg.mode === "confirm" || cfg.mode === "auto")) {
          if (settings?.kill_switch) action = "blocked: kill switch";
          else {
            const p = e.analysis.suggest;
            const sig = await db.from("signals").insert({
              instrument: cfg.instrument, side: e.side, model: "A", session_window: e.window, entry: p.entry, stop: p.stop, target: p.target,
              rr: e.gate.rr, grade: e.gate.grade, gate: e.gate.boxes, state: "ARMED", edge_version: "3.0", source: "autopilot",
            }).select("id").single();
            if (sig.error) throw new Error(sig.error.message);
            signalId = sig.data.id as string;
            action = await queue(db, cfg, e, signalId);
          }
        }
        if (cfg.events.includes(e.state) || (tradeable && cfg.events.includes("ARMED"))) {
          await sendTelegram(db, { text: stateMessage(e, cfg.mode), chats, kind: e.state, instrument: cfg.instrument, signalId, source: "autopilot" });
          if (action === "none") action = "alert";
        }
        await db.from("autopilot_runs").insert({
          instrument: cfg.instrument, side: e.side, state: e.state, grade: e.gate?.grade ?? null, verdict: e.gate?.verdict ?? null, price: e.price, action,
          detail: { plan: planKey, source: e.source, window: e.window, newsClear: e.newsClear, waitingFor: e.gate?.waitingFor ?? [], blockers: e.gate?.blockers ?? [], suggest: e.analysis.suggest },
        });
      }
      const paper = await managePaper(db, cfg, e.ltf, chats);
      out.push({ instrument: cfg.instrument, state: e.state, action: [action, paper].filter((x) => x && x !== "none").join(" · ") || "none" });
    } catch (err) {
      await db.from("autopilot_runs").insert({ instrument: cfg.instrument, state: "ERROR", action: "error", detail: { error: (err as Error).message } });
      out.push({ instrument: cfg.instrument, state: "ERROR", action: (err as Error).message });
    }
  }
  return out;
}

async function queue(db: SupabaseClient, cfg: AutopilotConfig, e: Evaluation, signalId: string): Promise<string> {
  if (!cfg.account_ids.length) return "signal only (no accounts assigned)";
  const def = INSTRUMENTS[cfg.instrument];
  const p = e.analysis.suggest!;
  const acc = await db.from("trading_accounts").select("id, name, balance, equity, risk_pct, active").in("id", cfg.account_ids);
  const rows = (acc.data ?? []).filter((a) => a.active).map((a) => {
    const s = sizePosition(def, { balance: Number(a.equity) || Number(a.balance), riskPct: Number(cfg.risk_pct) || Number(a.risk_pct), entry: p.entry, stop: p.stop });
    const action = s.belowMinimum ? "BLOCK" : cfg.mode === "paper" ? "PAPER" : "CONFIRM";
    return {
      signal_id: signalId, account_id: a.id, client_order_id: clientOrderId(signalId, a.id), action, side: e.side, qty: s.size,
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
  const pend = await db.from("orders").select("*, signals!inner(instrument, model, session_window, rr)").eq("action", "PAPER").eq("status", "queued").eq("signals.instrument", cfg.instrument);
  for (const o of pend.data ?? []) {
    const created = Date.parse(o.created_at);
    const bars = ltf.filter((c) => c.t + tfMs > created);
    const long = o.side === "long";
    const fillBar = bars.find((c) => (long ? c.l <= o.entry : c.h >= o.entry));
    const ranAway = bars.find((c) => (long ? c.h >= o.target : c.l <= o.target));
    if (fillBar && (!ranAway || fillBar.t <= ranAway.t)) {
      const upd = await db.from("orders").update({ status: "filled", fill_price: o.entry, filled_at: new Date(Math.max(fillBar.t, created)).toISOString() }).eq("id", o.id).eq("status", "queued").select("id");
      if (!upd.data?.length) continue;
      await db.from("trades").insert({
        account_id: o.account_id, signal_id: o.signal_id, instrument: cfg.instrument, side: o.side, model: o.signals.model, session_window: o.signals.session_window,
        qty: o.qty, entry: o.entry, stop: o.stop, target: o.target, planned_r: o.signals.rr, grade: "A+", source: "paper", risk_pct: cfg.risk_pct,
        opened_at: new Date(Math.max(fillBar.t, created)).toISOString(),
      });
      notes.push("paper fill");
    } else if (ranAway || bars.length >= 12) {
      await db.from("orders").update({ status: "cancelled", reasons: [...(o.reasons ?? []), ranAway ? "ran away before fill" : "expired"] }).eq("id", o.id).eq("status", "queued");
      notes.push("paper cancel");
    }
  }
  const open = await db.from("trades").select("*").eq("instrument", cfg.instrument).eq("source", "paper").is("exit", null);
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
        if (cfg.events.includes("CLOSED")) {
          await sendTelegram(db, { text: `${r > 0 ? "✅" : "❌"} <b>${escapeHtml(cfg.instrument)} closed ${r > 0 ? "+" : ""}${r.toFixed(2)}R</b>\n${long ? "Long" : "Short"} ${fmt(Number(t.entry))} → ${fmt(exit)} · ${escapeHtml(acc.data?.name ?? "")} · paper`, chats, kind: "CLOSED", instrument: cfg.instrument, signalId: t.signal_id, source: "autopilot" });
        }
        notes.push(`closed ${r.toFixed(2)}R`);
      }
      break;
    }
  }
  return notes.join(", ");
}
