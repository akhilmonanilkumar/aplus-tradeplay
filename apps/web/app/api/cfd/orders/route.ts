import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { placeAll, placeLeg } from "@/lib/server/cfdOrders";
import { errMsg } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/cfd/orders { legId } → place this account's order on cTrader now (confirm mode).
 * POST /api/cfd/orders { alertId } → place on every account that can take the signal.
 * Each Place re-checks the signal and re-sizes under the firm's rules before sending.
 */
export async function POST(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  const b = (await req.json().catch(() => null)) as { legId?: string; alertId?: string } | null;
  const id = b?.legId ?? b?.alertId;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "legId or alertId is required" }, { status: 400 });
  try {
    const { data } = await db.auth.getUser();
    const by = data.user?.email ?? "app";
    const r = b?.legId ? await placeLeg(db, id, by) : await placeAll(db, id, by);
    return Response.json(r.orders ? r : { ...r, error: r.message }, { status: r.orders ? 200 : 409 });
  } catch (e) {
    return Response.json({ error: errMsg(e) }, { status: 500 });
  }
}
