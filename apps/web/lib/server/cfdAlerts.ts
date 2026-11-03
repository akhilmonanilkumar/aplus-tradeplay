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
  const risk = Math.abs(plan.entry - plan.stop);
  const r = (x: number) => (risk ? Math.abs(x - plan.entry) / risk : 0).toFixed(1);
  const ist = new Date(plan.expiresAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  const meta = [plan.model ? `Model ${escapeHtml(plan.model)}` : null, plan.grade ? `grade ${escapeHtml(plan.grade)}` : null].filter(Boolean).join(" · ");
  const lines = [
    `${long ? "🟢 <b>BUY" : "🔴 <b>SELL"} ${escapeHtml(symbol)}</b> · A+ signal`,
    "",
    `Entry (limit): <b>${fmtPx(plan.entry, digits)}</b>`,
    `Stop loss: <b>${fmtPx(plan.stop, digits)}</b>`,
    `TP1: <b>${fmtPx(tp.tp1, digits)}</b> (${r(tp.tp1)}R)`,
    `TP2: <b>${fmtPx(tp.tp2, digits)}</b> (${r(tp.tp2)}R)`,
    `Expires: ${ist} IST`,
    ...(meta ? [meta] : []),
    "",
    ...legs.map((l) => (l.blocked ? `⛔ ${escapeHtml(l.name)}: ${escapeHtml(l.blocked)}` : `• ${escapeHtml(l.name)}: <b>${l.lots.toFixed(2)} lots</b>${l.legs.length === 2 ? ` (${l.legs[0]!.toFixed(2)} at TP1 + ${l.legs[1]!.toFixed(2)} at TP2)` : ""} · risk $${Math.round(l.risk)}${l.bound !== "risk" ? ` · capped by ${l.bound}` : ""}`)),
    ...(plan.why?.length ? ["", ...plan.why.slice(0, 3).map((w) => `· ${escapeHtml(w)}`)] : []),
  ];
  return lines.join("\n");
}

/** cTrader order mode for CFD alerts: "confirm" adds a Place button per account (each tap sends one order). */
export async function cfdExecMode(db: SupabaseClient): Promise<"off" | "confirm"> {
  const s = await db.from("app_settings").select("integrations").eq("id", 1).maybeSingle();
  return (s.data?.integrations as { cfd_exec?: { mode?: string } } | null)?.cfd_exec?.mode === "confirm" ? "confirm" : "off";
}

/**
 * Buttons on a signal. Orders on (confirm mode): one Place button that sends the order to every account
 * that can take it (plus one per account when there are several), and Skip. Orders off: the cTrader links
 * and Taken / Skip.
 */
export function alertButtons(alertId: string, legs: { name: string; lots: number; link: string | null; legId?: string; blocked?: string | null }[], place = false): InlineButton[][] {
  const ready = legs.filter((l) => l.legId && !l.blocked);
  if (place && ready.length) {
    return [
      [{ text: ready.length === 1 ? `📤 Place trade · ${ready[0]!.name} · ${ready[0]!.lots.toFixed(2)} lots` : `📤 Place on all ${ready.length} accounts`, callback_data: `cfd:pa:${alertId}` }],
      ...(ready.length > 1 ? ready.map((l) => [{ text: `Place · ${l.name} · ${l.lots.toFixed(2)} lots`, callback_data: `cfd:p:${l.legId}` }]) : []),
      [{ text: "Skip", callback_data: `cfd:s:${alertId}` }],
    ];
  }
  return [
    ...legs.filter((l) => l.link).map((l) => [{ text: `Open in cTrader · ${l.name} · ${l.lots.toFixed(2)}`, url: l.link! }]),
    [{ text: "✅ Taken", callback_data: `cfd:t:${alertId}` }, { text: "Skip", callback_data: `cfd:s:${alertId}` }],
  ];
}

/** Prop accounts that trade a symbol, with the closed trades their rule state is built from. */
export async function propAccountsFor(db: SupabaseClient, symbol: string, instrument: string) {
  const accRes = await db.from("trading_accounts").select("id, name, currency, start_balance, balance, equity, active, instruments, firm_rules").eq("active", true);
  const accounts = ((accRes.data ?? []) as PropAccount[]).filter((a) => rulesOf(a) && (!a.instruments?.length || a.instruments.includes(symbol) || a.instruments.includes(instrument)));
  const tr = accounts.length ? await db.from("trades").select("account_id, pnl, closed_at").in("account_id", accounts.map((a) => a.id)).not("closed_at", "is", null).gte("closed_at", new Date(Date.now() - 120 * 86_400_000).toISOString()) : { data: [] };
  return { accounts, closed: (tr.data ?? []) as ClosedTrade[] };
}

export function sizeLegs(accounts: PropAccount[], closed: ClosedTrade[], plan: AlertPlan, symbol: string, alertId: string, tp: { tp1: number; tp2: number }) {
  const legs = accounts.map((a) => ({ a, ...legFor(a, rulesOf(a)!, stateOf(a, closed), plan, symbol, alertId, tp) }));
  const view = legs.map((l) => ({ accountId: l.a.id, name: l.a.name, lots: l.size.lots, legs: l.size.legs, risk: l.size.riskAmount, blocked: l.size.blocked, bound: l.size.boundBy, link: l.link }));
  return { legs, view, digits: legs[0]?.spec.digits ?? CTRADER_SPECS[symbol]?.digits ?? 2 };
}

const legRow = (alertId: string, v: ReturnType<typeof sizeLegs>["view"][number]) => ({
  alert_id: alertId, account_id: v.accountId, lots: v.lots, legs: v.legs, risk_amount: Math.round(v.risk * 100) / 100, bound_by: v.bound, blocked: v.blocked, link: v.link,
});

/** Build, store and send the alert for one armed setup. Returns null when the market is not a CFD Arena market. */
export async function sendCfdAlert(db: SupabaseClient, chats: Chat[], plan: AlertPlan) {
  const symbol = toCTraderSymbol(plan.instrument);
  if (!symbol) return null;
  const { accounts, closed } = await propAccountsFor(db, symbol, plan.instrument);
  if (!accounts.length) return { skipped: "no prop accounts with rules" };
  const tp = targets(plan);
  const ins = await db.from("cfd_alerts").insert({
    signal_id: plan.signalId ?? null, instrument: plan.instrument, symbol, side: plan.side, model: plan.model ?? null, grade: plan.grade ?? null,
    entry: plan.entry, stop: plan.stop, tp1: tp.tp1, tp2: tp.tp2, expires_at: new Date(plan.expiresAt).toISOString(), why: plan.why ?? [],
    levels_at: new Date().toISOString(),
  }).select("id").single();
  if (ins.error) return { error: ins.error.message };
  const alertId = ins.data.id as string;
  const { view, digits } = sizeLegs(accounts, closed, plan, symbol, alertId, tp);
  const ins2 = await db.from("cfd_alert_legs").insert(view.map((v) => legRow(alertId, v))).select("id, account_id");
  const ids = new Map(((ins2.data ?? []) as { id: string; account_id: string }[]).map((x) => [x.account_id, x.id]));
  const withIds = view.map((v) => ({ ...v, legId: ids.get(v.accountId) }));
  const place = (await cfdExecMode(db)) === "confirm";
  const sent = await sendTelegram(db, { text: alertText(plan, symbol, digits, tp, view), chats, kind: "CFD", instrument: symbol, signalId: plan.signalId ?? null, source: "autopilot", markup: { inline_keyboard: alertButtons(alertId, withIds, place) }, cfdAlertId: alertId });
  return { alertId, sent: !sent.error, error: sent.error };
}

/**
 * Re-size every leg for new levels (the cTrader links carry the levels, so they are rebuilt too) and
 * send an update with the new buttons. What each account already did (taken / skipped) is kept.
 */
export async function reviseCfdAlert(db: SupabaseClient, chats: Chat[], alertId: string, plan: AlertPlan, before: { entry: number; stop: number; tp1: number; tp2: number }, notify: boolean, cancelled = 0) {
  const symbol = toCTraderSymbol(plan.instrument);
  if (!symbol) return;
  const { accounts, closed } = await propAccountsFor(db, symbol, plan.instrument);
  const tp = targets(plan);
  const { view, digits } = sizeLegs(accounts, closed, plan, symbol, alertId, tp);
  const up = view.length ? await db.from("cfd_alert_legs").upsert(view.map((v) => legRow(alertId, v)), { onConflict: "alert_id,account_id" }).select("id, account_id") : { data: [] };
  const ids = new Map(((up.data ?? []) as { id: string; account_id: string }[]).map((x) => [x.account_id, x.id]));
  const withIds = view.map((v) => ({ ...v, legId: ids.get(v.accountId) }));
  const place = (await cfdExecMode(db)) === "confirm";
  if (!notify) return;
  const f = (x: number) => fmtPx(x, digits);
  const move = (k: string, a: number, b: number) => (Math.abs(a - b) > 0 ? `${k} ${f(a)} → <b>${f(b)}</b>` : `${k} ${f(b)}`);
  const text = [
    `✏️ <b>${escapeHtml(symbol)} ${plan.side === "long" ? "LONG" : "SHORT"} · levels updated</b>`,
    `${move("Entry", before.entry, plan.entry)} · ${move("SL", before.stop, plan.stop)}`,
    `${move("TP1", before.tp1, tp.tp1)} · ${move("TP2", before.tp2, tp.tp2)}`,
    cancelled ? `Your ${cancelled} pending cTrader order${cancelled === 1 ? " was" : "s were"} cancelled. Tap Place to send the new levels.` : "If you placed the old order, change it or use the new link.",
    "",
    ...view.map((l) => (l.blocked ? `⛔ ${escapeHtml(l.name)}: ${escapeHtml(l.blocked)}` : `• ${escapeHtml(l.name)}: <b>${l.lots.toFixed(2)} lots</b> · risk $${Math.round(l.risk)}`)),
  ].join("\n");
  await sendTelegram(db, { text, chats, kind: "CFD", instrument: symbol, signalId: plan.signalId ?? null, source: "autopilot", markup: { inline_keyboard: alertButtons(alertId, withIds, place) }, cfdAlertId: alertId });
}

/** Tell Telegram an alert is over before it filled, so a pending order can be cancelled. */
export async function endCfdAlertNotice(db: SupabaseClient, chats: Chat[], a: { id: string; symbol: string; side: string; signalId: string | null }, outcome: string, reason: string) {
  const head = outcome === "ran_away" ? "ran away" : outcome === "dead" ? "setup dead" : outcome;
  const text = [`⛔ <b>${escapeHtml(a.symbol)} ${a.side === "long" ? "LONG" : "SHORT"} · ${escapeHtml(head)}</b>`, escapeHtml(reason), "Cancel the pending limit in cTrader if you placed it."].join("\n");
  await sendTelegram(db, { text, chats, kind: "CFD", instrument: a.symbol, signalId: a.signalId, source: "autopilot", cfdAlertId: a.id });
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
