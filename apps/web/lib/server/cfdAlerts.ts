import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CTRADER_SPECS, ctraderSignalLink, propRoom, propSize, toCTraderSymbol, valuePerPointPerLot,
  type CTraderSpec, type PropRules, type PropState,
} from "@aplus/engine";
import { escapeHtml, sendTelegram, type Chat, type InlineButton } from "@/lib/server/telegram";
import { rulesOf, stateOf, targets, type AlertPlan, type ClosedTrade, type PropAccount } from "@/lib/propAccounts";

export { dayStart, rulesOf, stateOf, targets, type AlertPlan, type PropAccount } from "@/lib/propAccounts";

/**
 * CFD Arena alerts. Each armed setup on a CFD market becomes one alert with a leg per prop account:
 * sized under that firm's rules, sent to Telegram with a cTrader signal link per account and
 * Taken / Skip buttons. The app never places prop-account orders.
 */

export function legFor(a: PropAccount, rules: PropRules, state: PropState, plan: AlertPlan, symbol: string, alertId: string, tp: { tp1: number; tp2: number }) {
  const spec: CTraderSpec = { ...CTRADER_SPECS[symbol]!, ...(a.firm_rules?.specs?.[symbol] ?? {}) };
  const room = propRoom(rules, state);
  const z = propSize(rules, state, room, {
    riskPct: a.firm_rules?.risk_pct ?? 0.5, entry: plan.entry, stop: plan.stop, target: plan.target,
    valuePerPointPerLot: valuePerPointPerLot(spec, plan.entry), lotStep: spec.lotStep, minLot: spec.minLot,
  });
  const link = z.blocked ? null : ctraderSignalLink({
    symbol: spec.symbol, order: "limit", direction: plan.side === "long" ? "buy" : "sell", price: plan.entry, sl: plan.stop, digits: spec.digits,
    tps: z.legs.length === 2 ? [{ price: tp.tp1, units: z.legs[0]! * spec.unitsPerLot }, { price: tp.tp2, units: z.legs[1]! * spec.unitsPerLot }] : [{ price: tp.tp2, units: z.lots * spec.unitsPerLot }],
    expiry: new Date(plan.expiresAt), comment: `APLUS ${alertId.slice(0, 8)} ${a.name}`,
  });
  return { size: z, room, link, spec };
}

const fmtPx = (x: number, d: number) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

export function alertText(plan: AlertPlan, symbol: string, digits: number, tp: { tp1: number; tp2: number; rr: number }, legs: { name: string; lots: number; legs: number[]; risk: number; blocked: string | null; bound: string }[]) {
  const long = plan.side === "long";
  const lines = [
    `${long ? "🟢" : "🔴"} <b>A+ ARMED · ${escapeHtml(symbol)} ${long ? "LONG" : "SHORT"}</b>`,
    [plan.model ? `Model ${escapeHtml(plan.model)}` : null, plan.grade ? `grade ${escapeHtml(plan.grade)}` : null, `${tp.rr.toFixed(1)}R`].filter(Boolean).join(" · "),
    `Entry ${fmtPx(plan.entry, digits)} (limit, expires ${new Date(plan.expiresAt).toISOString().slice(11, 16)} UTC)`,
    `SL ${fmtPx(plan.stop, digits)} · TP1 ${fmtPx(tp.tp1, digits)} · TP2 ${fmtPx(tp.tp2, digits)}`,
    "",
    ...legs.map((l) => (l.blocked ? `⛔ ${escapeHtml(l.name)}: ${escapeHtml(l.blocked)}` : `• ${escapeHtml(l.name)}: <b>${l.lots.toFixed(2)} lots</b>${l.legs.length === 2 ? ` (${l.legs[0]!.toFixed(2)} + ${l.legs[1]!.toFixed(2)})` : ""} · risk $${Math.round(l.risk)}${l.bound !== "risk" ? ` · capped by ${l.bound}` : ""}`)),
    ...(plan.why?.length ? ["", ...plan.why.slice(0, 3).map((w) => `· ${escapeHtml(w)}`)] : []),
  ];
  return lines.join("\n");
}

export function alertButtons(alertId: string, legs: { name: string; lots: number; link: string | null }[]): InlineButton[][] {
  return [
    ...legs.filter((l) => l.link).map((l) => [{ text: `Open in cTrader · ${l.name} · ${l.lots.toFixed(2)}`, url: l.link! }]),
    [{ text: "✅ Taken", callback_data: `cfd:t:${alertId}` }, { text: "Skip", callback_data: `cfd:s:${alertId}` }],
  ];
}

/** Build, store and send the alert for one armed setup. Returns null when the market is not a CFD Arena market. */
export async function sendCfdAlert(db: SupabaseClient, chats: Chat[], plan: AlertPlan) {
  const symbol = toCTraderSymbol(plan.instrument);
  if (!symbol) return null;
  const accRes = await db.from("trading_accounts").select("id, name, currency, start_balance, balance, equity, active, instruments, firm_rules").eq("active", true);
  const accounts = ((accRes.data ?? []) as PropAccount[]).filter((a) => rulesOf(a) && (!a.instruments?.length || a.instruments.includes(symbol) || a.instruments.includes(plan.instrument)));
  if (!accounts.length) return { skipped: "no prop accounts with rules" };
  const tr = await db.from("trades").select("account_id, pnl, closed_at").in("account_id", accounts.map((a) => a.id)).not("closed_at", "is", null).gte("closed_at", new Date(Date.now() - 120 * 86_400_000).toISOString());
  const tp = targets(plan);
  const ins = await db.from("cfd_alerts").insert({
    signal_id: plan.signalId ?? null, instrument: plan.instrument, symbol, side: plan.side, model: plan.model ?? null, grade: plan.grade ?? null,
    entry: plan.entry, stop: plan.stop, tp1: tp.tp1, tp2: tp.tp2, expires_at: new Date(plan.expiresAt).toISOString(), why: plan.why ?? [],
  }).select("id").single();
  if (ins.error) return { error: ins.error.message };
  const alertId = ins.data.id as string;
  const legs = accounts.map((a) => {
    const r = legFor(a, rulesOf(a)!, stateOf(a, (tr.data ?? []) as ClosedTrade[]), plan, symbol, alertId, tp);
    return { a, ...r };
  });
  await db.from("cfd_alert_legs").insert(legs.map((l) => ({
    alert_id: alertId, account_id: l.a.id, lots: l.size.lots, legs: l.size.legs, risk_amount: Math.round(l.size.riskAmount * 100) / 100,
    bound_by: l.size.boundBy, blocked: l.size.blocked, link: l.link,
  })));
  const view = legs.map((l) => ({ name: l.a.name, lots: l.size.lots, legs: l.size.legs, risk: l.size.riskAmount, blocked: l.size.blocked, bound: l.size.boundBy, link: l.link }));
  const digits = legs[0]?.spec.digits ?? 2;
  const sent = await sendTelegram(db, { text: alertText(plan, symbol, digits, tp, view), chats, kind: "CFD", instrument: symbol, signalId: plan.signalId ?? null, source: "autopilot", markup: { inline_keyboard: alertButtons(alertId, view) }, cfdAlertId: alertId });
  return { alertId, sent: !sent.error, error: sent.error };
}

/** Record Taken / Skip for every leg of an alert (from Telegram or the app). */
export async function markAlert(db: SupabaseClient, alertId: string, action: "taken" | "skipped", by: string, accountId?: string) {
  let q = db.from("cfd_alert_legs").update({ action, action_at: new Date().toISOString(), action_by: by }).eq("alert_id", alertId).is("blocked", null);
  if (accountId) q = q.eq("account_id", accountId);
  const legs = await q.select("id");
  if (legs.error) return legs.error.message;
  const st = await db.from("cfd_alerts").update({ status: action }).eq("id", alertId).eq("status", "armed");
  return st.error?.message ?? null;
}
