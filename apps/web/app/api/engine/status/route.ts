import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { engineConfigured, engineFetch } from "@/lib/server/engineHost";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** GET /api/engine/status → the engine host's venues (keys, execution, clock, stream), tick store and IP. Staff only. */
export async function GET(req: Request) {
  if (!(await staffFromRequest(req))) return unauthorized();
  if (!engineConfigured()) return json({ connected: false, reason: "ENGINE_URL and ENGINE_SECRET are not set in Vercel" });
  try {
    return json({ connected: true, ...(await engineFetch<Record<string, unknown>>("GET", "/status")) });
  } catch (e) {
    return json({ connected: false, reason: errMsg(e) });
  }
}
