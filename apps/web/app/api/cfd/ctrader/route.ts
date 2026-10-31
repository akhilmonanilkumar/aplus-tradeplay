import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { engineFetch } from "@/lib/server/engineHost";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** GET → the cTrader sign-in link (read-only "accounts" scope). POST { code } → finish sign-in on the engine host. */
export async function GET(req: Request) {
  if (!(await staffFromRequest(req))) return unauthorized();
  try { return json(await engineFetch<{ url: string }>("GET", "/ctrader/auth-url")); } catch (e) { return json({ error: errMsg(e) }, 0, 502); }
}

export async function POST(req: Request) {
  if (!(await staffFromRequest(req))) return unauthorized();
  const { code } = ((await req.json().catch(() => ({}))) as { code?: string });
  if (!code || code.length > 2048) return json({ error: "code missing" }, 0, 400);
  try { return json(await engineFetch<{ ok: boolean }>("POST", "/ctrader/code", { code }, 15_000)); } catch (e) { return json({ error: errMsg(e) }, 0, 502); }
}
