"use client";

import { useEffect, useState } from "react";
import { staffGet } from "@/lib/market";

/** Open paper and tracked trades marked to the latest price, for the dashboard's open-positions card. */

export interface LiveRow {
  id: string; kind: "paper" | "ledger"; instrument: string; side: "long" | "short"; model: string | null; account: string | null;
  entry: number; stop: number; target: number | null; plannedR: number | null; openedAt: string; price: number | null; uR: number | null; uPnl: number | null; digits: number;
}
export interface Live { at: number; trades: LiveRow[]; tracked: LiveRow[]; pending: unknown[]; totals: { open: number; uPnl: number; uR: number; tracked: number; trackedR: number } }

/** Open paper and tracked trades with live prices; polls while the tab is visible. */
export function useOpenTrades(everyMs = 5_000) {
  const [d, setD] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try { const x = await staffGet<Live>("/api/paper/live"); if (!stop) { setD(x); setError(null); } } catch (e) { if (!stop) setError((e as Error).message); }
      }
      if (!stop) timer = setTimeout(load, everyMs);
    };
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [everyMs]);
  return { d, error };
}
