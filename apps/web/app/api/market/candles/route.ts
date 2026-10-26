import { instrumentOk, loadCandles, tfOk } from "@/lib/server/feeds";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** GET /api/market/candles?i=XAUUSD&tf=5m&limit=300 → closed candles + forming bar + source. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const i = q.get("i"), tf = q.get("tf");
  if (!instrumentOk(i) || !tfOk(tf)) return json({ error: "bad instrument or timeframe" }, 0, 400);
  const limit = Math.max(50, Math.min(1500, Number(q.get("limit")) || 300));
  try {
    return json(await loadCandles(i, tf, limit, q.get("source") ?? undefined), tf === "1m" || tf === "5m" ? 5 : 20);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
