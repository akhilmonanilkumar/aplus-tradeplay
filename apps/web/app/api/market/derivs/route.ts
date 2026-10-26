import { loadDerivs } from "@/lib/server/derivs";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** GET /api/market/derivs?symbol=BTCUSDT|XAUUSDT → funding, OI and ΔOI regime, L/S, taker flow, basis. */
export async function GET(req: Request) {
  const s = new URL(req.url).searchParams.get("symbol");
  if (s !== "BTCUSDT" && s !== "XAUUSDT") return json({ error: "symbol must be BTCUSDT or XAUUSDT" }, 0, 400);
  try {
    return json(await loadDerivs(s), 30);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
