import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { engineFetch } from "@/lib/server/engineHost";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * GET → the Fyers login link (Fyers' own page; it sends the trader back to Integrations with ?auth_code=).
 * POST { code } → finish the login on the engine host, which keeps the token and renews it daily with the PIN.
 */
export async function GET(req: Request) {
  if (!(await staffFromRequest(req))) return unauthorized();
  try { return json(await engineFetch<{ url: string }>("GET", "/fyers/login-url?state=fyers")); } catch (e) { return json({ error: errMsg(e) }, 0, 502); }
}

export async function POST(req: Request) {
  if (!(await staffFromRequest(req))) return unauthorized();
  const { code } = ((await req.json().catch(() => ({}))) as { code?: string });
  if (!code || code.length > 4096) return json({ error: "auth code missing" }, 0, 400);
  try { return json(await engineFetch<{ ok: boolean }>("POST", "/fyers/token", { code }, 15_000)); } catch (e) { return json({ error: errMsg(e) }, 0, 502); }
}
