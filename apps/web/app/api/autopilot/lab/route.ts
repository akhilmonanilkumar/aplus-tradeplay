import { isInstrument } from "@aplus/engine";
import { hasSecret, hasVaultSecret, staffFromRequest } from "@/lib/server/auth";
import { errMsg } from "@/lib/server/http";
import { strategyLab, structureReport, type Family } from "@/lib/server/strategyLab";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/autopilot/lab?i=XAUUSD&family=a5|a15|session|models|structure&days=180[&m1=1] — candidate strategy families
 * on a long walk-forward window, judged against fixed pass criteria. Read-only; same auth as the tick.
 */
export async function GET(req: Request) {
  const ok = hasSecret(req, process.env.AUTOPILOT_SECRET) || hasSecret(req, process.env.CRON_SECRET) || (await hasVaultSecret(req)) || !!(await staffFromRequest(req));
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const i = q.get("i"), family = q.get("family") as Family | null;
  if (!i || !isInstrument(i)) return Response.json({ error: "unknown instrument" }, { status: 400 });
  if (family === ("structure" as Family)) {
    try { return Response.json(await structureReport(i)); } catch (e) { return Response.json({ error: errMsg(e) }, { status: 500 }); }
  }
  if (family !== "a5" && family !== "a15" && family !== "session" && family !== "models") return Response.json({ error: "family must be a5, a15, session or models" }, { status: 400 });
  try {
    return Response.json(await strategyLab(i, family, Number(q.get("days")) || 180, { m1: q.get("m1") === "1" }));
  } catch (e) {
    return Response.json({ error: errMsg(e) }, { status: 500 });
  }
}
