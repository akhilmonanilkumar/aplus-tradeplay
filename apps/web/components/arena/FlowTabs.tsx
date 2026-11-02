"use client";

import type { OiRegime } from "@aplus/engine";
import { useApi } from "@/lib/useApi";
import { num } from "@/lib/fmt";
import type { FlowSnapshot } from "@/lib/flowTypes";
import type { Derivs } from "@/lib/server/derivs";
import { Card, Chip, Empty, ErrorNote } from "@/components/ui";
import { BarChart, LineChart } from "@/components/charts";

/** Where a market's order flow comes from. CFDs borrow it from the matching perpetual. */
export interface FlowSource { venue: "delta" | "coinswitch" | "fyers"; symbol: string; tick: number; digits: number; note?: string }

const REGIME: Record<Exclude<OiRegime, "neutral">, string> = { long_build: "Long build-up", short_build: "Short build-up", short_cover: "Short covering", long_unwind: "Long unwinding" };
const hhmm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
const compact = (v: number) => (Math.abs(v) >= 1e6 ? `${num(v / 1e6, 1)}M` : Math.abs(v) >= 1e3 ? `${num(v / 1e3, 1)}k` : num(v, Math.abs(v) < 10 ? 2 : 0));

function useFlow(src: FlowSource, bucketMs = 300_000) {
  const q = new URLSearchParams({ venue: src.venue, symbol: src.symbol, bucket: String(bucketMs), tick: String(src.tick), bars: "8", depth: "0.01" });
  return useApi<FlowSnapshot>(`/api/market/flow?${q}`, 5_000);
}

function Source({ f, src }: { f: FlowSnapshot | null; src: FlowSource }) {
  return <p className="faint" style={{ fontSize: 12 }}>{src.note ? `${src.note} · ` : ""}{f ? `${f.source} · ${new Date(f.at).toLocaleTimeString("en-GB")}` : "Loading…"}</p>;
}

/** Footprint as a grid: one column per bar, one row per price level, sell × buy, tinted by the dominant side. */
function Footprint({ f, digits }: { f: FlowSnapshot; digits: number }) {
  const bars = f.footprint.slice(-6);
  if (!bars.length) return <Empty>No trades in this window yet</Empty>;
  const prices = [...new Set(bars.flatMap((b) => b.cells.map((c) => c.price)))].sort((a, b) => b - a).slice(0, 18);
  const max = Math.max(1, ...bars.flatMap((b) => b.cells.map((c) => c.buy + c.sell)));
  return (
    <div className="tbl-w">
      <table className="tbl mono" style={{ fontSize: 11.5 }}>
        <thead><tr><th>Price</th>{bars.map((b) => <th key={b.t} className="r">{hhmm(b.t)}</th>)}</tr></thead>
        <tbody>
          {prices.map((p) => (
            <tr key={p}>
              <td className="faint">{num(p, digits)}</td>
              {bars.map((b) => {
                const c = b.cells.find((x) => x.price === p);
                if (!c) return <td key={b.t} />;
                const tot = c.buy + c.sell, d = (c.buy - c.sell) / Math.max(tot, 1e-12);
                const imb = b.imbalances.find((x) => x.price === p);
                return (
                  <td key={b.t} className="r" style={{ background: `color-mix(in srgb, var(${d >= 0 ? "--up" : "--down"}) ${Math.round(6 + Math.abs(d) * 30 * Math.min(1, tot / max + 0.3))}%, transparent)`, fontWeight: b.poc === p ? 700 : 400, color: imb ? `var(${imb.side === "buy" ? "--up" : "--down"})` : undefined }}>
                    {compact(c.sell)} × {compact(c.buy)}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr><td className="faint">Delta</td>{bars.map((b) => <td key={b.t} className={`r ${b.delta >= 0 ? "up" : "down"}`}>{b.delta >= 0 ? "+" : ""}{compact(b.delta)}</td>)}</tr>
        </tbody>
      </table>
    </div>
  );
}

export function OrderFlowTab({ src }: { src: FlowSource }) {
  const { data: f, error } = useFlow(src);
  const last = f?.footprint.at(-1);
  const buys = f?.largeTrades.filter((t) => t.side === "buy").length ?? 0, sells = (f?.largeTrades.length ?? 0) - buys;
  const cvdNow = f?.cvd.at(-1)?.cvd ?? 0, cvdThen = f?.cvd[0]?.cvd ?? 0;
  const pxNow = f?.cvd.at(-1)?.price ?? 0, pxThen = f?.cvd[0]?.price ?? 0;
  const divergence = f && f.cvd.length > 3 && Math.sign(cvdNow - cvdThen) !== Math.sign(pxNow - pxThen) && pxNow !== pxThen;
  return (
    <>
      <ErrorNote error={error} />
      <section className="g12">
        <Card span={8} title="Footprint" right={<span className="faint" style={{ fontSize: 12.5 }}>5m · sell × buy per price · bold = point of control</span>}>
          {f ? <Footprint f={f} digits={src.digits} /> : <Empty>Loading order flow…</Empty>}
        </Card>
        <Card span={4} title="What the flow says">
          {!f ? <Empty>Loading…</Empty> : (
            <>
              {[
                ["Delta, this bar", last ? `${last.delta >= 0 ? "+" : ""}${compact(last.delta)} · ${last.delta >= 0 ? "buyers lead" : "sellers lead"}` : "—", last && last.delta >= 0 ? "up" : "down"],
                ["Cumulative delta vs price", divergence ? "Diverging: watch for a turn" : "Moving together", divergence ? "warn" : ""],
                ["Stacked imbalances", last?.imbalances.length ? `${last.imbalances.length} ${last.imbalances.filter((x) => x.side === "buy").length >= last.imbalances.length / 2 ? "buy" : "sell"}-side levels` : "None this bar", ""],
                ["Large prints", `${buys} buys · ${sells} sells`, buys >= sells ? "up" : "down"],
                ["Point of control", last?.poc ? num(last.poc, src.digits) : "—", ""],
                ["Book imbalance (1%)", f.book?.stats ? `${f.book.stats.imbalance >= 0 ? "+" : ""}${num(f.book.stats.imbalance * 100, 1)}% ${f.book.stats.imbalance >= 0 ? "bids" : "asks"}` : "—", f.book?.stats && f.book.stats.imbalance >= 0 ? "up" : "down"],
              ].map(([k, v, t]) => <div key={k} className="between" style={{ padding: "9px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}><span className="muted">{k}</span><span className={t}>{v}</span></div>)}
              <div style={{ marginTop: 10 }}><Source f={f} src={src} /></div>
            </>
          )}
        </Card>
        <Card span={12} title="Cumulative delta" right={<span className="faint" style={{ fontSize: 12.5 }}>rising means buyers are lifting offers</span>}>
          {f ? <LineChart vals={f.cvd.map((x) => x.cvd)} labels={f.cvd.map((x) => hhmm(x.t))} zero fmt={compact} /> : <Empty>Loading…</Empty>}
        </Card>
      </section>
    </>
  );
}

export function DepthTab({ src }: { src: FlowSource }) {
  const { data: f, error } = useFlow(src);
  const b = f?.book;
  const maxSize = Math.max(1, ...(b ? [...b.bids, ...b.asks].map((l) => l.size) : [1]));
  const Ladder = ({ side }: { side: "ask" | "bid" }) => {
    const rows = side === "ask" ? [...(b?.asks ?? [])].slice(0, 12).reverse() : (b?.bids ?? []).slice(0, 12);
    return <>{rows.map((l) => (
      <div key={`${side}${l.price}`} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", padding: "3px 8px", position: "relative", fontSize: 12 }} className="mono">
        <i style={{ position: "absolute", inset: "0 0 0 auto", width: `${(l.size / maxSize) * 100}%`, borderRadius: 4, background: `color-mix(in srgb, var(${side === "ask" ? "--down" : "--up"}) 14%, transparent)` }} />
        <span className={side === "ask" ? "down" : "up"} style={{ position: "relative" }}>{num(l.price, src.digits)}</span>
        <span className="r" style={{ position: "relative", textAlign: "right" }}>{compact(l.size)}</span>
      </div>
    ))}</>;
  };
  return (
    <>
      <ErrorNote error={error} />
      <section className="g12">
        <Card span={5} title="Order book" right={b?.stats ? <Chip>spread {num(b.stats.spread, src.digits)}</Chip> : undefined}>
          {!b ? <Empty>Loading…</Empty> : (
            <>
              <Ladder side="ask" />
              <div className="between mono" style={{ padding: "7px 8px", background: "var(--surface-2)", borderRadius: 6, margin: "2px 0", fontWeight: 600 }}><span>{b.stats ? num(b.stats.mid, src.digits) : "—"}</span><span className="faint" style={{ fontWeight: 400 }}>mid</span></div>
              <Ladder side="bid" />
            </>
          )}
        </Card>
        <Card span={7} title="Liquidity within 1%">
          {!b?.stats ? <Empty>Loading…</Empty> : (
            <>
              <div className="g12" style={{ gap: 12 }}>
                <div className="s4 stat"><div className="k">Bids</div><div className="v up">{compact(b.stats.bidsWithin)}</div></div>
                <div className="s4 stat"><div className="k">Asks</div><div className="v down">{compact(b.stats.asksWithin)}</div></div>
                <div className="s4 stat"><div className="k">Imbalance</div><div className={`v ${b.stats.imbalance >= 0 ? "up" : "down"}`}>{b.stats.imbalance >= 0 ? "+" : ""}{num(b.stats.imbalance * 100, 1)}%</div></div>
              </div>
              <h4 style={{ fontSize: 13, margin: "18px 0 4px" }}>Big resting orders</h4>
              {[...b.stats.askWalls.map((w) => ({ ...w, side: "Ask wall" })), ...b.stats.bidWalls.map((w) => ({ ...w, side: "Bid wall" }))].length === 0
                ? <p className="faint" style={{ fontSize: 12.5 }}>No level stands out (walls are 3× the median size).</p>
                : [...b.stats.askWalls.map((w) => ({ ...w, side: "Ask wall" })), ...b.stats.bidWalls.map((w) => ({ ...w, side: "Bid wall" }))].map((w) => (
                  <div key={`${w.side}${w.price}`} className="between" style={{ padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
                    <span><span className={w.side === "Ask wall" ? "down" : "up"}>{w.side}</span> <span className="mono">{num(w.price, src.digits)}</span></span><span className="mono">{compact(w.size)}</span>
                  </div>
                ))}
              <h4 style={{ fontSize: 13, margin: "18px 0 4px" }}>Large trades</h4>
              {(f?.largeTrades ?? []).slice(0, 8).map((t, i) => (
                <div key={i} className="between mono" style={{ padding: "6px 0", borderTop: "1px solid var(--line)", fontSize: 12.5 }}>
                  <span className="faint">{new Date(t.t).toLocaleTimeString("en-GB")}</span><span className={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "Buy" : "Sell"} {num(t.price, src.digits)}</span><span>{compact(t.size)}</span>
                </div>
              ))}
              <div style={{ marginTop: 10 }}><Source f={f ?? null} src={src} /></div>
            </>
          )}
        </Card>
      </section>
    </>
  );
}

/** Open interest and funding: Binance-led cross-venue data for BTC and gold, else the venue's own ticker. */
export function OiTab({ src, derivs }: { src: FlowSource; derivs: "BTCUSDT" | "XAUUSDT" | null }) {
  const d = useApi<Derivs>(derivs ? `/api/market/derivs?symbol=${derivs}` : null, 60_000);
  const { data: f } = useFlow(src);
  const x = d.data;
  const regime = x?.oi.windows.find((w) => w.label.includes("4h"))?.regime ?? x?.oi.windows[0]?.regime ?? null;
  return (
    <>
      <ErrorNote error={d.error} />
      <section className="g12">
        <Card span={8} title="Open interest" right={x?.oi.nowUsd ? <span className="mono">${compact(x.oi.nowUsd)}</span> : f?.ticker?.oi ? <span className="mono">{compact(f.ticker.oi)}</span> : undefined}>
          {x?.oi.hist.length ? <LineChart vals={x.oi.hist.map((h) => h.usd)} labels={x.oi.hist.map((h) => hhmm(h.t))} color="var(--delta)" h={260} fmt={(v) => `$${compact(v)}`} />
            : f?.oiHistory.length ? <LineChart vals={f.oiHistory.map((h) => h.oi)} labels={f.oiHistory.map((h) => hhmm(h.t))} color="var(--delta)" h={260} fmt={compact} />
            : <Empty>{derivs ? "Loading…" : "OI history builds up once the engine host is streaming this market"}</Empty>}
        </Card>
        <Card span={4} title="Regime">
          <div className="g12" style={{ gap: 8, marginBottom: 12 }}>
            {(Object.keys(REGIME) as (keyof typeof REGIME)[]).map((r) => (
              <div key={r} className="s6" style={{ padding: 12, borderRadius: 10, background: regime === r ? "color-mix(in srgb, var(--accent) 12%, var(--surface-2))" : "var(--surface-2)", boxShadow: regime === r ? "0 0 0 1px var(--accent) inset" : "none" }}>
                <b style={{ fontWeight: 500, color: regime === r ? "var(--accent-ink)" : undefined, fontSize: 13 }}>{REGIME[r]}</b>
              </div>
            ))}
          </div>
          {(x?.oi.windows ?? []).map((w) => (
            <div key={w.label} className="between" style={{ padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
              <span className="muted">{w.label}</span><span className="mono">price {w.priceChg === null ? "—" : `${w.priceChg >= 0 ? "+" : ""}${num(w.priceChg, 2)}%`} · OI {w.oiChg === null ? "—" : `${w.oiChg >= 0 ? "+" : ""}${num(w.oiChg, 2)}%`}</span>
            </div>
          ))}
          {!derivs && <p className="faint" style={{ fontSize: 12.5 }}>Cross-venue OI regime is available for BTC and gold.</p>}
        </Card>
        <Card span={6} title="Funding by venue" right={<span className="faint" style={{ fontSize: 12.5 }}>8h rate</span>}>
          {x?.venues.length
            ? <BarChart data={[...x.venues.filter((v) => v.funding !== null).map((v) => ({ v: v.funding! * 100, l: v.venue, c: "var(--delta)" })), ...(f?.ticker?.funding !== undefined ? [{ v: f.ticker.funding * 100, l: src.venue === "delta" ? "Delta" : src.venue, c: "var(--accent)" }] : [])]} fmt={(v) => `${v.toFixed(4)}%`} />
            : f?.ticker?.funding !== undefined ? <div className="stat"><div className="k">{src.venue} funding</div><div className="v">{(f.ticker.funding * 100).toFixed(4)}%</div></div> : <Empty>Loading…</Empty>}
        </Card>
        <Card span={6} title="Long/short ratio" right={<span className="faint" style={{ fontSize: 12.5 }}>top traders by position</span>}>
          {x?.ls.top.length ? <LineChart vals={x.ls.top.map((p) => p.ratio)} labels={x.ls.top.map((p) => hhmm(p.t))} color="var(--info)" fmt={(v) => v.toFixed(2)} /> : <Empty>{derivs ? "Loading…" : "Available for BTC and gold"}</Empty>}
        </Card>
      </section>
    </>
  );
}
