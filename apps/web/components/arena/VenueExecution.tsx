"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { num } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote } from "@/components/ui";
import type { ExecVenue } from "@/lib/venueExec";

type Order = { id: string; created_at: string; symbol: string; side: string; status: string; contracts: number; limit_price: number | null; stop: number | null; target: number | null; risk_usd: number | null; rr: number | null; reasons: string[]; error: string | null; meta: { strategy?: string; stage?: string; currency?: string; unit?: string; priceFrom?: string; productNote?: string | null; payload?: unknown } };

const NAME: Record<ExecVenue, string> = { coinswitch: "CoinSwitch", fyers: "Fyers" };

/** CoinSwitch / Fyers execution: mode, sizing base, and every order the gate planned with its exact payload. */
export default function VenueExecution({ venue }: { venue: ExecVenue }) {
  const me = useMe();
  const cfg = me.settings?.integrations?.execution?.[venue] ?? { mode: "off" as const };
  const orders = useRows<Order>({ table: "live_orders", eq: ["venue", venue], order: "created_at", limit: 40 });
  const [equity, setEquity] = useState(String(cfg.equity ?? (venue === "fyers" ? 100000 : 1000)));
  const [risk, setRisk] = useState(String((cfg.policy as { riskPct?: number } | undefined)?.riskPct ?? 0.5));
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(orders.reload, 30_000); return () => clearInterval(t); }, [orders.reload]);
  const ccy = venue === "fyers" ? "₹" : "$";

  const save = async (patch: Record<string, unknown>) => {
    const integ = me.settings?.integrations ?? { telegram_chats: [], ai_model: null };
    const next = { ...cfg, ...patch };
    const e = await me.updateSettings({ integrations: { ...integ, execution: { ...(integ.execution ?? {}), [venue]: next } } });
    setMsg(e ?? "Saved: applies on the next pass");
  };
  const saveSizing = () => {
    const eq = Number(equity), rp = Number(risk);
    if (!(eq > 0)) return setMsg("Equity must be above zero");
    if (!(rp >= 0.05 && rp <= 1)) return setMsg("Risk per trade must be between 0.05% and 1%");
    save({ equity: eq, policy: { ...((cfg.policy as object) ?? {}), riskPct: rp } });
  };
  const rows = orders.rows ?? [];

  return (
    <>
      <ErrorNote error={orders.error && /venue/.test(orders.error) ? "Apply migration 20261102100000_venue_exec.sql first." : orders.error} />
      {msg && <div className="banner info">{msg}</div>}
      <section className="g12">
        <Card span={4} title={`${NAME[venue]} execution`}>
          <div className="seg" role="group" aria-label="Mode" style={{ display: "flex", marginBottom: 12 }}>
            {(["off", "shadow", "live"] as const).map((m) => (
              <button key={m} type="button" style={{ flex: 1 }} className={cfg.mode === m ? "on" : ""} disabled={m === "live"} title={m === "live" ? "Unlocks after the first supervised order" : undefined} onClick={() => save({ mode: m })}>
                {m === "off" ? "Off" : m === "shadow" ? "Shadow" : "Live 🔒"}
              </button>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            {cfg.mode === "off" ? "Nothing is planned." : "Every signal of a strategy the League promoted on " + NAME[venue] + " goes through the same risk gate as Delta and is logged with the exact order it would send. Nothing is sent."}
          </p>
          <div className="col" style={{ gap: 10, marginTop: 14 }}>
            <label className="fld"><span>Size against equity</span><div className="inp"><span className="u">{ccy}</span><input inputMode="decimal" value={equity} onChange={(e) => setEquity(e.target.value)} /></div></label>
            <label className="fld"><span>Risk per trade (full size)</span><div className="inp"><input inputMode="decimal" value={risk} onChange={(e) => setRisk(e.target.value)} /><span className="u">%</span></div></label>
            <button className="btn sm" onClick={saveSizing}>Save sizing</button>
            <p className="faint" style={{ fontSize: 12 }}>Strategies at the League's small-size stage trade a quarter of this. Kill switch, daily caps, news blocks and stale-signal checks all apply.</p>
          </div>
          <h4 style={{ fontSize: 13, margin: "16px 0 6px" }}>Before Live unlocks</h4>
          {(venue === "coinswitch"
            ? ["Engine host running with CoinSwitch keys", "Quantity step and tick confirmed from instruments-info", "Stop-loss and take-profit fields confirmed on one small supervised order", "Fills and positions reconciled back into the order log"]
            : ["Engine host running and the new Fyers app on its static IP", "Near-month future and lot size checked against the symbol master", "Futures basis taken from the Fyers quote, not the index", "Entry, stop and target orders checked on one supervised lot"]
          ).map((x) => <div key={x} className="row" style={{ fontSize: 12.5, padding: "4px 0" }}><span className="faint">○</span>{x}</div>)}
        </Card>
        <Card span={8} title="Planned orders" right={<span className="faint" style={{ fontSize: 12.5 }}>{rows.length} recent</span>}>
          {rows.length === 0 ? <Empty>{cfg.mode === "off" ? "Switch to Shadow to start planning orders." : "No orders yet. They appear when a strategy promoted on this venue fires."}</Empty> : rows.map((o) => (
            <div key={o.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
              <div className="between" style={{ fontSize: 13, gap: 10, flexWrap: "wrap" }}>
                <span><b style={{ fontWeight: 500 }}>{o.side === "buy" ? "Buy" : "Sell"} {o.symbol}</b> <span className="faint">· {o.meta.strategy ?? ""}{o.meta.stage === "live_small" ? " · small size" : ""}</span></span>
                <span className="row" style={{ gap: 6 }}>
                  <span className="mono" style={{ fontSize: 12 }}>{num(Number(o.contracts), o.meta.unit === "lot" ? 0 : 3)} {o.meta.unit === "lot" ? "units" : o.meta.unit ?? ""} @ {o.limit_price ?? "—"} · SL {o.stop ?? "—"} · TP {o.target ?? "—"}{o.risk_usd ? ` · risk ${ccy}${num(Number(o.risk_usd), 0)}` : ""}</span>
                  <Chip tone={o.status === "dry-run" ? "info" : o.status === "rejected" || o.status === "error" ? "down" : ""}>{o.status === "dry-run" ? "shadow" : o.status}</Chip>
                  {o.meta.payload != null && <button className="btn ghost sm" onClick={() => setOpen(open === o.id ? null : o.id)}>{open === o.id ? "Hide" : "Payload"}</button>}
                </span>
              </div>
              {(o.reasons.length > 0 || o.error) && <p className="faint" style={{ fontSize: 12, marginTop: 4 }}>{[...o.reasons, o.error].filter(Boolean).join(" · ")}</p>}
              <p className="faint" style={{ fontSize: 11.5 }}>{new Date(o.created_at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })} IST · price from {o.meta.priceFrom ?? "—"}{o.meta.productNote ? ` · ${o.meta.productNote}` : ""}</p>
              {open === o.id && <pre className="mono" style={{ fontSize: 11.5, background: "var(--surface-2)", padding: 10, borderRadius: 8, overflowX: "auto", marginTop: 6 }}>{JSON.stringify(o.meta.payload, null, 2)}</pre>}
            </div>
          ))}
        </Card>
      </section>
    </>
  );
}
