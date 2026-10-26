import { hasSecret, serviceClient, staffFromRequest } from "@/lib/server/auth";
import { previewSelector, tick } from "@/lib/server/autopilot";
import { errMsg } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Autopilot pass. Called every 5 minutes by a scheduler with `Authorization: Bearer $AUTOPILOT_SECRET`
 * (GitHub Actions / cron-job.org / Vercel Cron's CRON_SECRET), or by staff from the Autopilot page.
 * `?preview=selector` scores the selector board without acting on it.
 */
async function run(req: Request) {
  const ok = hasSecret(req, process.env.AUTOPILOT_SECRET) || hasSecret(req, process.env.CRON_SECRET) || !!(await staffFromRequest(req));
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const db = serviceClient();
  if (!db) return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  try {
    if (new URL(req.url).searchParams.get("preview") === "selector") return Response.json({ at: Date.now(), preview: await previewSelector(db) });
    return Response.json({ at: Date.now(), ...(await tick(db)) });
  } catch (e) {
    return Response.json({ error: errMsg(e) }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
