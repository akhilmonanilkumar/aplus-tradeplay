import type { Candle } from "@aplus/engine";

export type Tf = "5m" | "15m" | "1h" | "4h";
export const INSTRUMENT_TF: Record<string, { htf: Tf; poi: Tf; ltf: Tf; label: string }> = {
  XAUUSD: { htf: "1h", poi: "15m", ltf: "5m", label: "1H · 15M · 5M" },
  "BTCUSDT.P": { htf: "4h", poi: "15m", ltf: "5m", label: "4H · 15M · 5M · mark price" },
};

/** Public feeds the browser can reach. Gold uses PAXG/USDT (1 token = 1 oz) as a labelled proxy. */
export const FEED: Record<string, { source: string; url: (tf: Tf, limit: number) => string; tv: string }> = {
  "BTCUSDT.P": {
    source: "Binance USDⓈ-M · mark price",
    url: (tf, limit) => `https://fapi.binance.com/fapi/v1/markPriceKlines?symbol=BTCUSDT&interval=${tf}&limit=${limit}`,
    tv: "BINANCE:BTCUSDT.P",
  },
  XAUUSD: {
    source: "PAXG/USDT proxy · Binance spot",
    url: (tf, limit) => `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${tf}&limit=${limit}`,
    tv: "OANDA:XAUUSD",
  },
};

const TF_MS: Record<Tf, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };

/** Closed candles only (the forming bar is dropped), so overlays never repaint. */
export async function fetchCandles(instrument: string, tf: Tf, limit = 300, signal?: AbortSignal): Promise<Candle[]> {
  const f = FEED[instrument];
  if (!f) throw new Error(`no feed for ${instrument}`);
  const res = await fetch(f.url(tf, limit + 1), { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`${f.source}: HTTP ${res.status}`);
  const rows = (await res.json()) as (string | number)[][];
  const now = Date.now();
  return rows
    .map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5] ?? 0) }))
    .filter((c) => c.t + TF_MS[tf] <= now);
}

/** Last traded / mark price (includes the forming bar). */
export async function fetchLast(instrument: string, signal?: AbortSignal): Promise<number | null> {
  const f = FEED[instrument];
  if (!f) return null;
  const res = await fetch(f.url("5m", 1), { signal, cache: "no-store" });
  if (!res.ok) return null;
  const rows = (await res.json()) as (string | number)[][];
  return rows.length ? Number(rows[rows.length - 1]![4]) : null;
}
