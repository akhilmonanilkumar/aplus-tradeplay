import { instrumentOk, loadQuote } from "@/lib/server/feeds";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** GET /api/market/quote?i=XAUUSD → bid / ask / last with source. */
export async function GET(req: Request) {
  const i = new URL(req.url).searchParams.get("i");
  if (!instrumentOk(i)) return json({ error: "bad instrument" }, 0, 400);
  try {
    return json(await loadQuote(i), 1);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
