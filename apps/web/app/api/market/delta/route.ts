import { type InstrumentId } from "@aplus/engine";
import { deltaPublic, type DeltaTicker } from "@/lib/server/delta";
import { loadQuote } from "@/lib/server/feeds";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const OURS: Record<string, InstrumentId> = { BTCUSD: "BTCUSDT.P", XAUTUSD: "XAUUSD" };

/**
 * GET /api/market/delta?symbol=BTCUSD|XAUTUSD → Delta Exchange India venue snapshot: mark, spot, best
 * bid/ask and spread, funding, open interest, 24h range, and the basis against our feed (what a live
 * order would pay relative to the price the signals are drawn on).
 */
export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get("symbol") ?? "BTCUSD";
  if (!(symbol in OURS)) return json({ error: "symbol must be BTCUSD or XAUTUSD" }, 0, 400);
  try {
    const [t, ours] = await Promise.all([deltaPublic<DeltaTicker & Record<string, unknown>>(`/v2/tickers/${symbol}`), loadQuote(OURS[symbol]!).catch(() => null)]);
    const bid = Number(t.quotes?.best_bid), ask = Number(t.quotes?.best_ask);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(t.mark_price);
    return json({
      at: Date.now(), symbol, mark: Number(t.mark_price), spot: Number(t.spot_price), last: Number(t.close), bid, ask, spread: ask - bid,
      fundingPct: Number(t.funding_rate), oi: Number(t.oi), oiUsd: Number((t as Record<string, unknown>).oi_value_usd ?? 0),
      oiChange6hUsd: Number((t as Record<string, unknown>).oi_change_usd_6h ?? 0), high: Number((t as Record<string, unknown>).high), low: Number((t as Record<string, unknown>).low),
      change24hPct: Number((t as Record<string, unknown>).ltp_change_24h ?? 0), ours: ours ? { instrument: OURS[symbol], price: ours.last, source: ours.source } : null,
      basis: ours ? mid - ours.last : null, basisPct: ours ? ((mid - ours.last) / ours.last) * 100 : null,
    }, 3);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
