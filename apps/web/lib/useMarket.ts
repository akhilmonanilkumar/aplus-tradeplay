"use client";

import { useEffect, useState } from "react";
import type { Candle } from "@aplus/engine";
import { INSTRUMENT_TF, fetchCandles } from "@/lib/market";

export interface MarketData { htf: Candle[]; poi: Candle[]; ltf: Candle[]; at: number }

/** HTF / POI / entry-TF closed candles for an instrument, refreshed every minute. */
export function useMarket(instrument: string) {
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const tf = INSTRUMENT_TF[instrument];
    if (!tf) return;
    let ctl = new AbortController();
    const load = async () => {
      ctl.abort();
      ctl = new AbortController();
      try {
        const [htf, poi, ltf] = await Promise.all([
          fetchCandles(instrument, tf.htf, 300, ctl.signal),
          fetchCandles(instrument, tf.poi, 400, ctl.signal),
          fetchCandles(instrument, tf.ltf, 300, ctl.signal),
        ]);
        setData({ htf, poi, ltf, at: Date.now() });
        setError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError(`Market data unavailable — ${(e as Error).message}`);
      }
    };
    setData(null);
    load();
    const t = setInterval(load, 60_000);
    return () => { clearInterval(t); ctl.abort(); };
  }, [instrument]);
  return { data, error };
}
