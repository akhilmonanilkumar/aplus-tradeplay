"use client";

import { useEffect, useRef, useState } from "react";
import type { InstrumentId } from "@aplus/engine";
import { api } from "@/lib/market";

export interface Tick { price: number; side: "buy" | "sell" | null; qty: number; t: number }
export interface Liq { side: "long" | "short"; price: number; qty: number; usd: number; t: number }
export interface Live {
  last: number | null;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  t: number | null;
  source: string;
  connected: boolean;
  tape: Tick[];
  liqs: Liq[];
}

const EMPTY: Live = { last: null, bid: null, ask: null, mark: null, t: null, source: "", connected: false, tape: [], liqs: [] };

/**
 * Tick stream per instrument, straight from the venue to the browser:
 * Binance USDⓈ-M (aggTrade + mark price + liquidations) for the perps,
 * Coinbase ticker for BTC-USD, and a 2.5 s quote poll for spot gold.
 * State is flushed at most 4× a second.
 */
export function useLive(id: InstrumentId): Live {
  const [live, setLive] = useState<Live>(EMPTY);
  const ref = useRef<Live>(EMPTY);
  useEffect(() => {
    ref.current = { ...EMPTY };
    setLive(ref.current);
    let dirty = false, closed = false;
    const flush = setInterval(() => { if (dirty) { dirty = false; setLive({ ...ref.current }); } }, 250);
    const patch = (p: Partial<Live>) => { ref.current = { ...ref.current, ...p }; dirty = true; };
    const pushTick = (t: Tick) => { ref.current.tape = [t, ...ref.current.tape].slice(0, 40); };
    let ws: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      if (id === "BTCUSDT.P" || id === "XAUUSDT.P") {
        const s = id === "BTCUSDT.P" ? "btcusdt" : "xauusdt";
        ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${s}@aggTrade/${s}@markPrice@1s/${s}@bookTicker/${s}@forceOrder`);
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data as string) as { stream: string; data: Record<string, unknown> };
          const d = m.data;
          if (m.stream.endsWith("@aggTrade")) {
            const price = Number(d.p);
            pushTick({ price, qty: Number(d.q), side: d.m ? "sell" : "buy", t: Number(d.T) });
            patch({ last: price, t: Number(d.T) });
          } else if (m.stream.includes("@markPrice")) patch({ mark: Number(d.p) });
          else if (m.stream.endsWith("@bookTicker")) patch({ bid: Number(d.b), ask: Number(d.a) });
          else if (m.stream.endsWith("@forceOrder")) {
            const o = d.o as Record<string, string | number>;
            const price = Number(o.ap || o.p), qty = Number(o.z || o.q);
            // A SELL liquidation order closes a long.
            ref.current.liqs = [{ side: (o.S === "SELL" ? "long" : "short") as Liq["side"], price, qty, usd: price * qty, t: Number(o.T) }, ...ref.current.liqs].slice(0, 30);
            dirty = true;
          }
        };
        ws.onopen = () => patch({ connected: true, source: `Binance ${id} stream` });
      } else if (id === "BTCUSD" || id === "BTCUSD.SPOT") {
        ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
        ws.onopen = () => { ws?.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] })); patch({ connected: true, source: "Coinbase BTC-USD stream" }); };
        ws.onmessage = (ev) => {
          const d = JSON.parse(ev.data as string) as Record<string, string>;
          if (d.type !== "ticker") return;
          const price = Number(d.price), t = Date.parse(d.time);
          pushTick({ price, qty: Number(d.last_size), side: d.side === "buy" ? "buy" : "sell", t });
          patch({ last: price, bid: Number(d.best_bid), ask: Number(d.best_ask), t });
        };
      } else {
        const load = async () => {
          try {
            const q = await api<{ bid: number | null; ask: number | null; last: number; ts: number; source: string }>(`/api/market/quote?i=${encodeURIComponent(id)}`);
            if (ref.current.last !== null && q.last !== ref.current.last) pushTick({ price: q.last, qty: 0, side: q.last > ref.current.last ? "buy" : "sell", t: q.ts });
            patch({ last: q.last, bid: q.bid, ask: q.ask, t: q.ts, source: q.source, connected: true });
          } catch { patch({ connected: false }); }
        };
        load();
        poll = setInterval(load, 2500);
        return;
      }
      ws.onclose = () => { patch({ connected: false }); if (!closed) retry = setTimeout(connect, 3000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      clearInterval(flush);
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [id]);
  return live;
}
