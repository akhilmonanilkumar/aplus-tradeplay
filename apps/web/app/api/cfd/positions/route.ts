import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { engineConfigured, engineFetch } from "@/lib/server/engineHost";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

type CtAccount = { ctid: number; login: number | null; isLive: boolean; balance: number | null; positions: unknown[]; syncedAt: number | null; error: string | null };

/**
 * GET /api/cfd/positions → open positions and balances read from cTrader (via the engine host), matched to
 * our accounts by login number (the account's broker account field). Staff only.
 */
export async function GET(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  if (!engineConfigured()) return json({ connected: false, reason: "The engine host is not connected" });
  try {
    const snap = await engineFetch<{ configured: boolean; signedIn: boolean; error: string | null; accounts: CtAccount[] }>("GET", "/ctrader");
    const accs = await db.from("trading_accounts").select("id, name, broker_account").eq("active", true);
    const byLogin = new Map((accs.data ?? []).filter((a) => a.broker_account).map((a) => [String(a.broker_account).trim(), a]));
    return json({
      connected: true, configured: snap.configured, signedIn: snap.signedIn, error: snap.error,
      accounts: snap.accounts.map((c) => { const a = c.login !== null ? byLogin.get(String(c.login)) : undefined; return { ...c, accountId: a?.id ?? null, name: a?.name ?? null }; }),
    });
  } catch (e) {
    return json({ connected: false, reason: errMsg(e) });
  }
}
