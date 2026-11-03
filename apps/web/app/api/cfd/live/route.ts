import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { syncCfdLive } from "@/lib/server/cfdLive";
import { errMsg } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cfd/live → the CFD live board: every confirmed CFD alert marked to the live price (armed, at the
 * entry, in the trade, ended and why), plus setups still forming. Each read also moves the alerts on:
 * phases, expiries and detector re-checks are written back. Polled every few seconds by the dashboard.
 */
export async function GET(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  try {
    return Response.json(await syncCfdLive(db), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: errMsg(e) }, { status: 500 });
  }
}
