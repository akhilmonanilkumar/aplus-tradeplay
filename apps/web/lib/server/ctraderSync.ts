import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { engineConfigured, engineFetch } from "@/lib/server/engineHost";

/**
 * cTrader → app, read-only. For every prop account matched by its login (the account's broker account
 * field): the balance from cTrader, every trade closed on it (imported once, by deal id, into the journal
 * and P&L), and alert legs marked Taken when an order placed from an alert link shows up. Runs on every
 * autopilot pass and from the Sync button.
 */

type Closed = { dealId: number; positionId: number; symbol: string; side: "long" | "short"; units: number; entry: number; exit: number; sl: number | null; pnl: number; fees: number; openedAt: number | null; closedAt: number; balanceAfter: number | null; comment: string | null };
type Snap = { accounts: { ctid: number; login: number | null; balance: number | null; positions: { id: number; symbol: string; comment: string | null; openedAt: number }[] }[] };

/** Broker symbol → our market id (the reverse of the alert mapping). */
export const fromCTraderSymbol = (s: string) => {
  const u = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (u.startsWith("XAUUSD")) return "XAUUSD";
  if (u.startsWith("BTCUSD")) return "BTCUSD";
  if (u.startsWith("US500") || u.startsWith("SPX")) return "SPX500";
  if (u.startsWith("NAS100") || u.startsWith("USTEC") || u.startsWith("NDX")) return "NAS100";
  for (const id of ["EURUSD", "GBPUSD", "USDJPY"]) if (u.startsWith(id)) return id;
  return s;
};

/** The alert an order came from: links put "APLUS <first 8 of the alert id>" in the order comment. */
export const alertRef = (comment: string | null) => comment?.match(/APLUS ([0-9a-f]{8})/i)?.[1]?.toLowerCase() ?? null;

export function tradeRow(accountId: string, t: Closed, alert: { signal_id: string | null; model: string | null } | null) {
  const instrument = fromCTraderSymbol(t.symbol);
  const stop = t.sl ?? t.entry;
  const risk = Math.abs(t.entry - stop);
  const dir = t.side === "long" ? 1 : -1;
  // Realised R on price; the P&L column already carries the broker's commission and swap.
  const r = risk > 0 ? (dir * (t.exit - t.entry)) / risk : null;
  return {
    account_id: accountId, external_id: `ct:${t.dealId}`, source: "ctrader", instrument, side: t.side, qty: t.units,
    entry: t.entry, stop, exit: t.exit, pnl: t.pnl, fees: t.fees, realized_r: r === null ? null : Math.round(r * 1000) / 1000,
    opened_at: new Date(t.openedAt ?? t.closedAt).toISOString(), closed_at: new Date(t.closedAt).toISOString(),
    signal_id: alert?.signal_id ?? null, model: alert?.model ?? null,
    review: t.sl === null ? "Imported from cTrader; stop not seen while open" : null,
  };
}

export async function syncCTrader(db: SupabaseClient): Promise<string> {
  if (!engineConfigured()) return "";
  const accs = await db.from("trading_accounts").select("id, name, broker_account, synced_at").not("broker_account", "is", null);
  const byLogin = new Map(((accs.data ?? []) as { id: string; name: string; broker_account: string; synced_at: string | null }[]).map((a) => [String(a.broker_account).trim(), a]));
  if (!byLogin.size) return "";
  const snap = await engineFetch<Snap>("GET", "/ctrader");
  if (!snap.accounts?.length) return "";
  const oldest = Math.min(...[...byLogin.values()].map((a) => (a.synced_at ? Date.parse(a.synced_at) - 86_400_000 : Date.now() - 30 * 86_400_000)));
  const closed = await engineFetch<{ accounts: { ctid: number; login: number | null; balance: number | null; trades: Closed[]; error: string | null }[] }>("GET", `/ctrader/closed?from=${oldest}`, undefined, 60_000);

  // Alerts by their short reference, for linking trades and marking legs Taken.
  const alerts = await db.from("cfd_alerts").select("id, signal_id, model").gte("created_at", new Date(Date.now() - 45 * 86_400_000).toISOString());
  const byRef = new Map(((alerts.data ?? []) as { id: string; signal_id: string | null; model: string | null }[]).map((a) => [a.id.slice(0, 8), a]));

  let imported = 0, taken = 0, balances = 0;
  const errors: string[] = [];
  for (const c of closed.accounts) {
    const acc = c.login !== null ? byLogin.get(String(c.login)) : undefined;
    if (!acc) continue;
    if (c.error) errors.push(`${acc.name}: ${c.error}`);
    if (c.trades.length) {
      const rows = c.trades.map((t) => tradeRow(acc.id, t, byRef.get(alertRef(t.comment) ?? "") ?? null));
      const up = await db.from("trades").upsert(rows, { onConflict: "account_id,external_id", ignoreDuplicates: true }).select("id");
      if (up.error) errors.push(`${acc.name}: ${up.error.message}`); else imported += up.data?.length ?? 0;
    }
    const live = snap.accounts.find((x) => x.ctid === c.ctid);
    const patch: Record<string, unknown> = { synced_at: new Date().toISOString() };
    if (c.balance !== null) {
      patch.balance = c.balance;
      // Without open positions equity equals balance; with them, keep the last equity until it can be marked.
      if (!live?.positions.length) patch.equity = c.balance;
      balances++;
    }
    await db.from("trading_accounts").update(patch).eq("id", acc.id);
    // Orders placed from an alert link: mark that account's leg Taken.
    const refs = [...(live?.positions ?? []).map((p) => p.comment), ...c.trades.map((t) => t.comment)].map(alertRef).filter((x): x is string => !!x);
    for (const ref of new Set(refs)) {
      const a = byRef.get(ref);
      if (!a) continue;
      const leg = await db.from("cfd_alert_legs").update({ action: "taken", action_at: new Date().toISOString(), action_by: "cTrader" }).eq("alert_id", a.id).eq("account_id", acc.id).is("action", null).select("id");
      if (leg.data?.length) {
        taken++;
        await db.from("cfd_alerts").update({ status: "taken" }).eq("id", a.id).in("status", ["armed", "expired"]);
      }
    }
  }
  return [imported ? `${imported} trade${imported === 1 ? "" : "s"} imported` : "", balances ? `${balances} balance${balances === 1 ? "" : "s"} synced` : "", taken ? `${taken} alert leg${taken === 1 ? "" : "s"} marked taken` : "", ...errors].filter(Boolean).join(" · ");
}
