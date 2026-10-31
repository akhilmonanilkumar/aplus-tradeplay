import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { liveStatus } from "@/lib/server/liveExec";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** GET /api/delta → live-execution status: mode, keys, products, and (with keys) wallet, positions and working orders. Staff only. */
export async function GET(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  try { return json(await liveStatus(db)); } catch (e) { return json({ error: errMsg(e) }, 0, 502); }
}
