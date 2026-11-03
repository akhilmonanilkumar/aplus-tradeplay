import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { targets } from "@/lib/propAccounts";
import { cfdExecMode, propAccountsFor, sizeLegs } from "@/lib/server/cfdAlerts";
import { engineConfigured, engineFetch } from "@/lib/server/engineHost";

/**
 * cTrader orders from CFD alerts, confirm mode only: nothing is sent until the trader taps Place for an
 * account (in the app or in a private Telegram chat with the bot). Each Place re-checks the alert and
 * re-sizes the leg under the firm's rules right then, cancels that account's earlier pending orders for
 * the alert, and sends one limit order per target (TP1 and TP2 legs) with the stop attached.
 */

type Alert = { id: string; instrument: string; symbol: string; side: "long" | "short"; entry: number; stop: number; tp1: number; tp2: number; expires_at: string; phase: string; status: string; signal_id: string | null };

export interface PlaceResult { ok: boolean; message: string; orders: number }

/** Why an alert cannot take an order now, or null. Pure, for tests. */
export function placeBlocker(a: Pick<Alert, "phase" | "status" | "expires_at">, now = Date.now()): string | null {
  if (a.phase === "ended") return "this setup has ended";
  if (a.phase === "in_trade") return "price already traded through the entry";
  if (a.status === "skipped") return "this alert was skipped";
  if (Date.parse(a.expires_at) - now < 60_000) return "the alert expires in under a minute";
  return null;
}

/** Order parts for a leg: two orders when the size splits across TP1 and TP2, else one at TP2. */
export function orderParts(lots: number, legs: number[], tp: { tp1: number; tp2: number }) {
  const parts = legs.length === 2 && legs.every((x) => x > 0) ? [{ part: 1, lots: legs[0]!, target: tp.tp1 }, { part: 2, lots: legs[1]!, target: tp.tp2 }] : [{ part: 1, lots, target: tp.tp2 }];
  return parts.filter((p) => p.lots > 0);
}

export async function placeLeg(db: SupabaseClient, legId: string, by: string): Promise<PlaceResult> {
  if ((await cfdExecMode(db)) !== "confirm") return { ok: false, message: "cTrader orders are off (CFD Arena → Alerts)", orders: 0 };
  if (!engineConfigured()) return { ok: false, message: "The engine host is not connected", orders: 0 };
  const legRes = await db.from("cfd_alert_legs").select("id, alert_id, account_id, trading_accounts(name, broker_account)").eq("id", legId).maybeSingle();
  const leg = legRes.data as unknown as { id: string; alert_id: string; account_id: string; trading_accounts: { name: string; broker_account: string | null } | null } | null;
  if (!leg) return { ok: false, message: "Alert leg not found", orders: 0 };
  const login = Number(leg.trading_accounts?.broker_account);
  if (!login) return { ok: false, message: `${leg.trading_accounts?.name ?? "This account"} has no cTrader login in its broker account field`, orders: 0 };
  const aRes = await db.from("cfd_alerts").select("id, instrument, symbol, side, entry, stop, tp1, tp2, expires_at, phase, status, signal_id").eq("id", leg.alert_id).maybeSingle();
  const a = aRes.data as Alert | null;
  if (!a) return { ok: false, message: "Alert not found", orders: 0 };
  const blocked = placeBlocker(a);
  if (blocked) return { ok: false, message: `Not placed: ${blocked}`, orders: 0 };

  // Size right now under the firm's rules, at the alert's current levels.
  const plan = { instrument: a.instrument, side: a.side, entry: Number(a.entry), stop: Number(a.stop), target: Number(a.tp2), expiresAt: Date.parse(a.expires_at), signalId: a.signal_id };
  const tp = targets(plan);
  const { accounts, closed } = await propAccountsFor(db, a.symbol, a.instrument);
  const acc = accounts.find((x) => x.id === leg.account_id);
  if (!acc) return { ok: false, message: "This account has no prop rules or does not trade this market", orders: 0 };
  const v = sizeLegs([acc], closed, plan, a.symbol, a.id, tp).view[0]!;
  if (v.blocked) return { ok: false, message: `Not placed: ${v.blocked}`, orders: 0 };

  const cancelled = await cancelOrders(db, { alertId: a.id, accountId: leg.account_id }, "replaced by a new Place");
  const parts = orderParts(v.lots, v.legs, { tp1: Number(a.tp1), tp2: Number(a.tp2) });
  let placed = 0;
  const errors: string[] = [];
  for (const p of parts) {
    const row = await db.from("cfd_orders").insert({ alert_id: a.id, leg_id: leg.id, account_id: leg.account_id, part: p.part, lots: p.lots, entry: plan.entry, stop: plan.stop, target: p.target, status: "placing", placed_by: by }).select("id").single();
    if (row.error) { errors.push(row.error.message); continue; }
    try {
      const r = await engineFetch<{ orderId: number | null }>("POST", "/ctrader/order", {
        login, symbol: a.symbol, side: a.side, lots: p.lots, entry: plan.entry, stop: plan.stop, target: p.target, expiresAt: plan.expiresAt,
        comment: `APLUS ${a.id.slice(0, 8)} ${acc.name}`, label: `Tradeplay ${p.part === 1 && parts.length === 2 ? "TP1" : "TP2"}`,
      }, 20_000);
      await db.from("cfd_orders").update({ status: "pending", order_id: r.orderId, updated_at: new Date().toISOString() }).eq("id", row.data.id);
      placed++;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(msg);
      await db.from("cfd_orders").update({ status: "failed", error: msg.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", row.data.id);
    }
  }
  if (placed) {
    await db.from("cfd_alert_legs").update({ action: "taken", action_at: new Date().toISOString(), action_by: by }).eq("id", leg.id);
    await db.from("cfd_alerts").update({ status: "taken" }).eq("id", a.id).eq("status", "armed");
  }
  const what = `${placed} of ${parts.length} order${parts.length === 1 ? "" : "s"} placed on ${acc.name} (${v.lots.toFixed(2)} lots)`;
  return { ok: placed === parts.length, message: [what, cancelled ? `${cancelled} earlier order${cancelled === 1 ? "" : "s"} cancelled` : "", ...errors].filter(Boolean).join(" · "), orders: placed };
}

/** Place on every account that can take the alert (its unblocked legs). */
export async function placeAll(db: SupabaseClient, alertId: string, by: string): Promise<PlaceResult> {
  const legs = await db.from("cfd_alert_legs").select("id").eq("alert_id", alertId).is("blocked", null);
  const ids = ((legs.data ?? []) as { id: string }[]).map((l) => l.id);
  if (!ids.length) return { ok: false, message: "No account can take this signal", orders: 0 };
  const out: PlaceResult[] = [];
  for (const id of ids) out.push(await placeLeg(db, id, by));
  return { ok: out.every((r) => r.ok), message: out.map((r) => r.message).join("\n"), orders: out.reduce((s, r) => s + r.orders, 0) };
}

/** Cancel pending orders of an alert (all accounts, or one). Returns how many were cancelled. */
export async function cancelOrders(db: SupabaseClient, where: { alertId: string; accountId?: string }, reason: string): Promise<number> {
  let q = db.from("cfd_orders").select("id, order_id, account_id, trading_accounts(broker_account)").eq("alert_id", where.alertId).eq("status", "pending");
  if (where.accountId) q = q.eq("account_id", where.accountId);
  const rows = ((await q).data ?? []) as unknown as { id: string; order_id: number | null; trading_accounts: { broker_account: string | null } | null }[];
  let n = 0;
  for (const r of rows) {
    const login = Number(r.trading_accounts?.broker_account);
    try {
      if (r.order_id && login) await engineFetch("POST", "/ctrader/cancel", { login, orderId: r.order_id }, 15_000);
      n++;
      await db.from("cfd_orders").update({ status: "cancelled", error: reason, updated_at: new Date().toISOString() }).eq("id", r.id);
    } catch (e) {
      // Already filled, expired or cancelled on cTrader: record why and move on.
      await db.from("cfd_orders").update({ status: "cancelled", error: `${reason} (cTrader: ${(e as Error).message.slice(0, 200)})`, updated_at: new Date().toISOString() }).eq("id", r.id);
    }
  }
  return n;
}
