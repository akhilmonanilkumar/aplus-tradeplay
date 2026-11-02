"use client";

import { useApi } from "@/lib/useApi";
import { num } from "@/lib/fmt";
import { Card, Chip, Empty, Row } from "@/components/ui";

interface Venue {
  at: number; symbol: string; mark: number; spot: number; last: number; bid: number; ask: number; spread: number; fundingPct: number; oi: number; oiUsd: number;
  oiChange6hUsd: number; high: number; low: number; change24hPct: number; ours: { instrument: string; price: number; source: string } | null; basis: number | null; basisPct: number | null;
}

/** Delta Exchange India venue snapshot: where live orders for this desk are placed. Refreshes every 10 s. */
export default function DeltaVenue({ desk }: { desk: "gold" | "btc" }) {
  const symbol = desk === "btc" ? "BTCUSD" : "XAUTUSD";
  const v = useApi<Venue>(`/api/market/delta?symbol=${symbol}`, 10_000);
  const d = v.data;
  const dg = desk === "btc" ? 1 : 2;
  const usdM = (x: number) => `$${(x / 1e6).toFixed(1)}M`;
  return (
    <Card span={4} title={`Delta Exchange · ${symbol} perp`} right={<Chip dot tone={v.error ? "down" : "info"}>{d ? new Date(d.at).toLocaleTimeString("en-GB") : v.error ? "offline" : "…"}</Chip>}>
      {!d ? <Empty>{v.error ?? "Loading venue…"}</Empty> : (
        <>
          <div className="between"><span className="kv">{num(d.mark, dg)}</span><span className={`mono ${d.change24hPct >= 0 ? "up" : "down"}`}>{d.change24hPct >= 0 ? "+" : ""}{d.change24hPct.toFixed(2)}%</span></div>
          <Row k="Bid / ask" v={<span className="mono">{num(d.bid, dg)} / {num(d.ask, dg)} · spread {num(d.spread, dg)}</span>} />
          <Row k="Spot index" v={<span className="mono">{num(d.spot, dg)}</span>} />
          <Row k="Funding (8h)" v={<span className={`mono ${d.fundingPct >= 0 ? "up" : "down"}`}>{d.fundingPct.toFixed(4)}%</span>} />
          <Row k="Open interest" v={<span className="mono">{usdM(d.oiUsd)} · 6h {d.oiChange6hUsd >= 0 ? "+" : ""}{usdM(d.oiChange6hUsd)}</span>} />
          <Row k="24h range" v={<span className="mono">{num(d.low, dg)} – {num(d.high, dg)}</span>} />
          {d.ours && d.basis !== null && <Row k={`Basis vs ${d.ours.instrument}`} v={<span className="mono">{d.basis >= 0 ? "+" : ""}{num(d.basis, dg)} ({d.basisPct!.toFixed(3)}%)</span>} />}
          <p className="faint" style={{ fontSize: 11, marginTop: 6 }}>Live orders for promoted {desk === "btc" ? "BTC" : "gold"} strategies go here; their levels shift by the basis so the stop and target keep the same R.</p>
        </>
      )}
    </Card>
  );
}
