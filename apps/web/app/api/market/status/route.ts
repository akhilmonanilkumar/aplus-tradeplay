import { marketStatuses } from "@/lib/server/feeds";
import { json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/status → one row per market: live price and its source, the candle feed the
 * autopilot reads and how old its newest closed 5M bar is, and whether the market is open.
 */
export async function GET() {
  const now = Date.now();
  return json({ at: now, markets: await marketStatuses(now) }, 5);
}
