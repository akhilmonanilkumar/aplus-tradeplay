import { INSTRUMENT_IDS, INSTRUMENTS, isFxClosed, type InstrumentId } from "@aplus/engine";
import { loadCandles, loadQuote } from "@/lib/server/feeds";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** NSE cash session, 09:15–15:30 IST on weekdays (holidays not modelled). */
function nseOpen(t: number) {
  const ist = new Date(t + 330 * 60_000);
  const day = ist.getUTCDay(), m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && m >= 9 * 60 + 15 && m < 15 * 60 + 30;
}

/**
 * GET /api/market/status → one row per market: live price and its source, the candle feed the
 * autopilot reads and how old its newest closed 5M bar is, and whether the market is open.
 * status: live (fresh bars), closed (market shut), stale (open but no new bar for 15+ min), down.
 */
export async function GET() {
  const now = Date.now();
  const rows = await Promise.all(INSTRUMENT_IDS.map(async (id: InstrumentId) => {
    const def = INSTRUMENTS[id];
    const open = id === "NIFTY" ? nseOpen(now) : def.fxHours ? !isFxClosed(now) : true;
    const [c, q] = await Promise.all([
      loadCandles(id, "5m", 20).then((x) => ({ ok: true as const, x }), (e) => ({ ok: false as const, e: errMsg(e) })),
      loadQuote(id).then((x) => ({ ok: true as const, x }), (e) => ({ ok: false as const, e: errMsg(e) })),
    ]);
    const last = c.ok ? c.x.candles.at(-1) : undefined;
    const barAgeMin = last ? Math.round((now - last.t - 300_000) / 60_000) : null;
    const status = !c.ok ? "down" : !open ? "closed" : barAgeMin !== null && barAgeMin > 15 ? "stale" : "live";
    return {
      id, label: def.label, desk: def.desk, digits: def.digits, open, status,
      feed: c.ok ? c.x.source : null, approx: c.ok ? c.x.approx : null, barAgeMin, error: c.ok ? (q.ok ? null : q.e) : c.e,
      price: q.ok ? q.x.last : last?.c ?? null, priceSource: q.ok ? q.x.source : null, quoteAgeSec: q.ok ? Math.round((now - q.x.ts) / 1000) : null,
    };
  }));
  return json({ at: now, markets: rows }, 5);
}
