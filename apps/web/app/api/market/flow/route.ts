import { bookStats, cvd, footprint, imbalances, type FlowTrade } from "@aplus/engine";
import { deltaPublic } from "@/lib/server/delta";
import { engineConfigured, engineFetch } from "@/lib/server/engineHost";
import { errMsg, json } from "@/lib/server/http";
import type { FlowSnapshot } from "@/lib/flowTypes";

export const dynamic = "force-dynamic";

const VENUES = new Set(["delta", "coinswitch", "fyers"]);
const num = (x: unknown) => (x === undefined || x === null || x === "" ? undefined : Number(x));

let contracts: { at: number; cv: Map<string, number> } | null = null;
async function contractValue(symbol: string) {
  if (!contracts || Date.now() - contracts.at > 600_000) {
    const ps = await deltaPublic<{ symbol: string; contract_value: string }[]>("/v2/products", { contract_types: "perpetual_futures", states: "live" });
    contracts = { at: Date.now(), cv: new Map(ps.map((p) => [p.symbol, Number(p.contract_value) || 1])) };
  }
  return contracts.cv.get(symbol) ?? 1;
}

/** Without the engine host: one REST snapshot of Delta's book, its latest public trades and the ticker. */
async function deltaFallback(symbol: string, bucketMs: number, tick: number, bars: number, depth: number): Promise<FlowSnapshot> {
  const [cv, ob, tr, tk] = await Promise.all([
    contractValue(symbol),
    deltaPublic<{ buy: { price: string; size: number }[]; sell: { price: string; size: number }[] }>(`/v2/l2orderbook/${symbol}`, { depth: 100 }),
    deltaPublic<{ trades: { side: string; size: number; price: string; timestamp: number }[] }>(`/v2/trades/${symbol}`),
    deltaPublic<Record<string, unknown>>(`/v2/tickers/${symbol}`),
  ]);
  const toMs = (x: number) => (x > 1e15 ? x / 1000 : x > 1e12 ? x : x * 1000);
  const lv = (xs: { price: string; size: number }[]) => xs.map((l) => ({ price: Number(l.price), size: l.size * cv }));
  const book = { t: Date.now(), bids: lv(ob.buy ?? []), asks: lv(ob.sell ?? []) };
  // The REST `side` is the taker's side.
  const trades: FlowTrade[] = (tr.trades ?? []).map((x) => ({ t: toMs(x.timestamp), price: Number(x.price), size: x.size * cv, side: x.side === "buy" ? "buy" : "sell" }));
  const fp = footprint(trades, bucketMs, tick).slice(-bars);
  const sizes = trades.map((x) => x.size).sort((a, b) => a - b);
  const big = sizes.length ? sizes[Math.floor(sizes.length * 0.95)]! : Infinity;
  return {
    venue: "delta", symbol, at: Date.now(), source: `Delta REST · latest ${trades.length} trades (connect the engine host for the full stream)`,
    ticker: { t: Date.now(), mark: num(tk.mark_price), last: num(tk.close), index: num(tk.spot_price), funding: tk.funding_rate === undefined ? undefined : Number(tk.funding_rate) / 100, oi: num(tk.oi) === undefined ? undefined : Number(tk.oi) * cv, oiUsd: num(tk.oi_value_usd) },
    book: { ...book, bids: book.bids.slice(0, 25), asks: book.asks.slice(0, 25), stats: bookStats(book, depth) },
    footprint: fp.map((b) => ({ ...b, imbalances: imbalances(b, 3) })),
    cvd: cvd(trades, Math.max(5_000, Math.round(bucketMs / 6))),
    largeTrades: trades.filter((x) => x.size >= big).sort((a, b) => b.t - a.t).slice(0, 20),
    tradeCount: trades.length, oiHistory: [],
  };
}

/**
 * GET /api/market/flow?venue=delta&symbol=BTCUSD&bucket=300000&tick=10&bars=12&depth=0.01
 * Order book, footprint, cumulative delta and large trades. From the engine host's live stream when it is
 * connected; for Delta without it, from one REST snapshot (labelled in `source`).
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const venue = u.searchParams.get("venue") ?? "delta", symbol = (u.searchParams.get("symbol") ?? "BTCUSD").toUpperCase();
  const bucket = Math.max(10_000, Math.min(3_600_000, Number(u.searchParams.get("bucket") ?? 300_000)));
  const tick = Math.max(1e-6, Number(u.searchParams.get("tick") ?? 10));
  const bars = Math.max(1, Math.min(48, Number(u.searchParams.get("bars") ?? 12)));
  const depth = Math.max(0.001, Math.min(0.05, Number(u.searchParams.get("depth") ?? 0.01)));
  if (!VENUES.has(venue) || !/^[A-Z0-9:._-]{2,40}$/.test(symbol)) return json({ error: "bad venue or symbol" }, 0, 400);
  if (engineConfigured()) {
    try {
      const q = new URLSearchParams({ venue, symbol, bucket: String(bucket), tick: String(tick), bars: String(bars), depth: String(depth) });
      const snap = await engineFetch<Omit<FlowSnapshot, "source">>("GET", `/flow?${q}`);
      return json({ ...snap, source: `Engine host · live ${venue} stream` }, 2);
    } catch (e) {
      if (venue !== "delta") return json({ error: errMsg(e) }, 0, 502);
    }
  } else if (venue !== "delta") {
    return json({ error: `${venue === "coinswitch" ? "CoinSwitch" : "Fyers"} market data needs the engine host (it signs every request)` }, 0, 503);
  }
  try {
    return json(await deltaFallback(symbol, bucket, tick, bars, depth), 3);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
