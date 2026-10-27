"use client";

import { useEffect, useState } from "react";
import { staffGet } from "@/lib/market";
import { money, num, r as fmtR } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Table } from "@/components/ui";

/** Open paper trades marked to market, refreshed every few seconds while the tab is visible. */

interface LiveTrade {
  id: string; instrument: string; side: "long" | "short"; model: string | null; account: string | null;
  entry: number; stop: number; target: number | null; qty: number; plannedR: number | null; openedAt: string;
  price: number | null; priceSource: string | null; uR: number | null; uPnl: number | null; digits: number;
}
interface LivePending { id: string; instrument: string; model: string | null; side: "long" | "short"; entry: number; stop: number; target: number | null; createdAt: string }
interface Live { at: number; trades: LiveTrade[]; pending: LivePending[]; totals: { open: number; uPnl: number; uR: number } }

const REFRESH_MS = 5_000;
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
};

export default function LivePnl({ span = 12 }: { span?: 12 | 6 }) {
  const [d, setD] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try { const x = await staffGet<Live>("/api/paper/live"); if (!stop) { setD(x); setError(null); } }
        catch (e) { if (!stop) setError((e as Error).message); }
      }
      if (!stop) timer = setTimeout(load, REFRESH_MS);
    };
    load();
    const onVis = () => { if (document.visibilityState === "visible") { clearTimeout(timer); load(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  const t = d?.totals;
  return (
    <Card span={span} title="Live paper P&L" right={
      <div className="row" style={{ gap: 6 }}>
        {t && <Chip tone={t.uPnl >= 0 ? "up" : "down"}>{money(t.uPnl)} · {fmtR(t.uR)}</Chip>}
        <Chip dot tone={error ? "down" : "info"}>{d ? `updated ${new Date(d.at).toLocaleTimeString("en-GB")}` : "loading"} · every {REFRESH_MS / 1000}s</Chip>
      </div>
    }>
      <ErrorNote error={error} />
      {!d ? null : d.trades.length === 0 ? <Empty>No open paper trades{d.pending.length ? ` · ${d.pending.length} order${d.pending.length === 1 ? "" : "s"} waiting for a fill` : ""}</Empty> : (
        <Table head={["Instrument", "Model", "Side", "Entry", "Now", "Stop", "Target", "Open R", "Open P&L", "Held"]} right={[3, 4, 5, 6, 7, 8, 9]}>
          {d.trades.map((x) => (
            <tr key={x.id}>
              <td>{x.instrument}{x.account && <div className="faint" style={{ fontSize: 10.5 }}>{x.account}</div>}</td>
              <td>{x.model ?? "—"}</td>
              <td><Chip tone={x.side === "long" ? "up" : "down"}>{x.side}</Chip></td>
              <td className="r mono">{num(x.entry, x.digits)}</td>
              <td className="r mono" title={x.priceSource ?? undefined}>{x.price === null ? "—" : num(x.price, x.digits)}</td>
              <td className="r mono">{num(x.stop, x.digits)}</td>
              <td className="r mono">{x.target === null ? "—" : num(x.target, x.digits)}{x.plannedR !== null && <span className="faint"> · {fmtR(x.plannedR)}</span>}</td>
              <td className={`r mono ${(x.uR ?? 0) >= 0 ? "up" : "down"}`}>{x.uR === null ? "—" : fmtR(x.uR)}</td>
              <td className={`r mono ${(x.uPnl ?? 0) >= 0 ? "up" : "down"}`}>{x.uPnl === null ? "—" : money(x.uPnl)}</td>
              <td className="r mono">{ago(x.openedAt)}</td>
            </tr>
          ))}
        </Table>
      )}
      {d && d.trades.length > 0 && d.pending.length > 0 && <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>{d.pending.length} paper order{d.pending.length === 1 ? "" : "s"} waiting for a fill: {d.pending.slice(0, 6).map((p) => `${p.instrument} ${p.side} @ ${p.entry}`).join(" · ")}</div>}
    </Card>
  );
}
