import { instrumentOk, loadHistory, tfOk } from "@/lib/server/feeds";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/market/history?i=&tf=&from=&to=&source= (ms) → closed candles for backtests (max 200 days).
 * `source` pins the provider (no fallback), so every timeframe of one run reads the same feed.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const i = q.get("i"), tf = q.get("tf");
  const to = Number(q.get("to")) || Date.now();
  const from = Math.max(Number(q.get("from")) || to - 30 * 86_400_000, to - 200 * 86_400_000);
  if (!instrumentOk(i) || !tfOk(tf)) return json({ error: "bad instrument or timeframe" }, 0, 400);
  try {
    // A window that ended in the past never changes: let the edge serve reruns.
    return json(await loadHistory(i, tf, from, to, { source: q.get("source") || undefined }), to < Date.now() ? 3600 : 300);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
