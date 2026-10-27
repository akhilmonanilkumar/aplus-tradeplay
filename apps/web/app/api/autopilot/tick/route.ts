import { hasSecret, hasVaultSecret, serviceClient, staffFromRequest } from "@/lib/server/auth";
import { previewSelector, tick } from "@/lib/server/autopilot";
import { research } from "@/lib/server/research";
import { isInstrument } from "@aplus/engine";
import { errMsg } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Autopilot pass. Called every 5 minutes by pg_cron with the Vault secret (`autopilot_secret_ok`), by
 * GitHub Actions with `Authorization: Bearer $AUTOPILOT_SECRET`, or by staff from the Autopilot page.
 * `?preview=selector` scores the selector board without acting on it.
 * `?research=XAUUSD&days=30&day=2026-10-26` replays the edge under the live and relaxed rules (no action).
 */
async function run(req: Request) {
  const ok = hasSecret(req, process.env.AUTOPILOT_SECRET) || hasSecret(req, process.env.CRON_SECRET) || (await hasVaultSecret(req)) || !!(await staffFromRequest(req));
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  try {
    const q = new URL(req.url).searchParams;
    const r = q.get("research");
    if (r) {
      if (!isInstrument(r)) return Response.json({ error: "unknown instrument" }, { status: 400 });
      return Response.json(await research(r, { days: Number(q.get("days")) || 30, day: q.get("day") ?? undefined }));
    }
    if (q.get("preview") === "selector") return Response.json({ at: Date.now(), preview: await previewSelector(db) });
    return Response.json({ at: Date.now(), ...(await tick(db)) });
  } catch (e) {
    return Response.json({ error: errMsg(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
