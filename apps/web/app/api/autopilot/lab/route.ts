import { isInstrument } from "@aplus/engine";
import { hasSecret, hasVaultSecret, staffFromRequest } from "@/lib/server/auth";
import { basisResearch } from "@/lib/server/basisResearch";
import { deltaProbe } from "@/lib/server/delta";
import { feedHealth } from "@/lib/server/feeds";
import { errMsg } from "@/lib/server/http";
import { strategyLab, structureReport, type Family } from "@/lib/server/strategyLab";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/autopilot/lab?i=XAUUSD&family=a5|a15|session|models|improve|structure&days=180[&m1=1][&source=<feed name>] — candidate strategy families
 * on a long walk-forward window, judged against fixed pass criteria. `family=feeds[&metered=1]` probes every
 * market-data provider; `family=basis` runs the funding research. Read-only; same auth as the tick.
 */
export async function GET(req: Request) {
  const ok = hasSecret(req, process.env.AUTOPILOT_SECRET) || hasSecret(req, process.env.CRON_SECRET) || (await hasVaultSecret(req)) || !!(await staffFromRequest(req));
  if (!ok) return Response.json({ error: "forbidden" }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const i = q.get("i"), family = q.get("family") as Family | null;
  if (family === ("delta" as Family)) {
    try { return Response.json(await deltaProbe()); } catch (e) { return Response.json({ error: errMsg(e) }, { status: 500 }); }
  }
  if (family === ("feeds" as Family)) {
    try { return Response.json(await feedHealth({ metered: q.get("metered") === "1" })); } catch (e) { return Response.json({ error: errMsg(e) }, { status: 500 }); }
  }
  if (family === ("basis" as Family)) {
    const symbols = (q.get("symbols") || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT").split(",").filter((s) => /^[A-Z0-9]{3,20}$/.test(s)).slice(0, 12);
    try { return Response.json(await basisResearch(symbols)); } catch (e) { return Response.json({ error: errMsg(e) }, { status: 500 }); }
  }
  if (!i || !isInstrument(i)) return Response.json({ error: "unknown instrument" }, { status: 400 });
  if (family === ("structure" as Family)) {
    try { return Response.json(await structureReport(i)); } catch (e) { return Response.json({ error: errMsg(e) }, { status: 500 }); }
  }
  if (family !== "a5" && family !== "a15" && family !== "session" && family !== "models" && family !== "improve") return Response.json({ error: "family must be a5, a15, session, models or improve" }, { status: 400 });
  try {
    return Response.json(await strategyLab(i, family, Number(q.get("days")) || 180, { m1: q.get("m1") === "1", source: q.get("source") || undefined }));
  } catch (e) {
    return Response.json({ error: errMsg(e) }, { status: 500 });
  }
}
