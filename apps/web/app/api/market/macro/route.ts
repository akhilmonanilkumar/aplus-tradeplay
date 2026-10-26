import { loadMacro } from "@/lib/server/macro";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** GET /api/market/macro?desk=gold|btc → DXY, yields, indices, correlations, COT. */
export async function GET(req: Request) {
  const d = new URL(req.url).searchParams.get("desk");
  if (d !== "gold" && d !== "btc") return json({ error: "desk must be gold or btc" }, 0, 400);
  try {
    return json(await loadMacro(d), 300);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
