"use client";

import { useEffect, useState } from "react";
import type { Candle } from "@aplus/engine";
import { INSTRUMENT_TF, fetchCandles } from "@/lib/market";

export interface MarketData { htf: Candle[]; poi: Candle[]; ltf: Candle[]; forming: Candle | null; at: number; source: string; approx: boolean; note?: string }

/** HTF / POI / entry-TF closed candles for an instrument, refreshed every 20 s (CDN-cached server side). */
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
        setData({ htf: htf.candles, poi: poi.candles, ltf: ltf.candles, forming: ltf.forming, at: Date.now(), source: ltf.source, approx: ltf.approx, note: ltf.note });
        setError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError(`Market data unavailable — ${(e as Error).message}`);
      }
    };
    setData(null);
    load();
    const t = setInterval(load, 20_000);
    return () => { clearInterval(t); ctl.abort(); };
  }, [instrument]);
  return { data, error };
}
