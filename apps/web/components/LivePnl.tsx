"use client";

import { useEffect, useState } from "react";
import { staffGet } from "@/lib/market";
import { money, num, r as fmtR } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Seg, Table } from "@/components/ui";

/**
 * Everything in a trade, marked to market and refreshed every few seconds while the tab is visible:
 * paper-account trades with P&L, and the setups the bot ledger tracks without an account (open R).
 */

interface LiveRow {
  id: string; kind: "paper" | "ledger"; gate: string; instrument: string; side: "long" | "short"; model: string | null; account: string | null;
  entry: number; stop: number; target: number | null; qty: number; plannedR: number | null; openedAt: string;
  price: number | null; priceSource: string | null; uR: number | null; uPnl: number | null; digits: number;
}
interface LivePending { id: string; instrument: string; model: string | null; side: "long" | "short"; entry: number; stop: number; target: number | null; createdAt: string }
interface Live { at: number; trades: LiveRow[]; tracked: LiveRow[]; pending: LivePending[]; totals: { open: number; uPnl: number; uR: number; tracked: number; trackedR: number } }
type Show = "all" | "paper" | "ledger";

const REFRESH_MS = 5_000;
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
};

export default function LivePnl({ span = 12, instrument }: { span?: 12 | 6; instrument?: string }) {
  const [d, setD] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>("all");

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setD(null);
    const load = async () => {
      if (document.visibilityState === "visible") {
        try { const x = await staffGet<Live>(`/api/paper/live${instrument ? `?i=${encodeURIComponent(instrument)}` : ""}`); if (!stop) { setD(x); setError(null); } }
        catch (e) { if (!stop) setError((e as Error).message); }
      }
      if (!stop) timer = setTimeout(load, REFRESH_MS);
    };
    load();
    const onVis = () => { if (document.visibilityState === "visible") { clearTimeout(timer); load(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { stop = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [instrument]);

  const t = d?.totals;
  const rows = d ? [...(show !== "ledger" ? d.trades : []), ...(show !== "paper" ? d.tracked : [])] : [];
  const compact = span === 6;
  return (
    <Card span={span} title={instrument ? `In trade · ${instrument}` : "Live P&L · everything in a trade"} right={
      <div className="row" style={{ gap: 6 }}>
        {t && t.open > 0 && <Chip tone={t.uPnl >= 0 ? "up" : "down"}>paper {money(t.uPnl)} · {fmtR(t.uR)}</Chip>}
        {t && t.tracked > 0 && <Chip tone={t.trackedR >= 0 ? "up" : "down"}>tracked {fmtR(t.trackedR)}</Chip>}
        <Chip dot tone={error ? "down" : "info"}>{d ? new Date(d.at).toLocaleTimeString("en-GB") : "loading"} · {REFRESH_MS / 1000}s</Chip>
      </div>
    }>
      <ErrorNote error={error} />
      {d && (d.trades.length > 0 && d.tracked.length > 0) && (
        <div style={{ marginBottom: 8 }}><Seg label="Show" value={show} onChange={setShow} options={[{ v: "all", l: `All ${d.trades.length + d.tracked.length}` }, { v: "paper", l: `Paper account ${d.trades.length}` }, { v: "ledger", l: `Tracked setups ${d.tracked.length}` }]} /></div>
      )}
      {!d ? null : rows.length === 0 ? <Empty>Nothing in a trade{d.pending.length ? ` · ${d.pending.length} order${d.pending.length === 1 ? "" : "s"} waiting for a fill` : ""}</Empty> : (
        <Table head={compact ? ["", "Side", "Entry", "Now", "Open R", "P&L"] : ["Instrument", "Model", "Gate", "Side", "Entry", "Now", "Stop", "Target", "Open R", "Open P&L", "Held"]} right={compact ? [2, 3, 4, 5] : [4, 5, 6, 7, 8, 9, 10]}>
          {rows.map((x) => compact ? (
            <tr key={x.id}>
              <td>{x.model ?? "—"}<div className="faint" style={{ fontSize: 10.5 }}>{x.kind === "paper" ? "paper" : x.gate} · {ago(x.openedAt)}</div></td>
              <td><Chip tone={x.side === "long" ? "up" : "down"}>{x.side}</Chip></td>
              <td className="r mono">{num(x.entry, x.digits)}</td>
              <td className="r mono" title={x.priceSource ?? undefined}>{x.price === null ? "—" : num(x.price, x.digits)}</td>
              <td className={`r mono ${(x.uR ?? 0) >= 0 ? "up" : "down"}`}>{x.uR === null ? "—" : fmtR(x.uR)}</td>
              <td className={`r mono ${(x.uPnl ?? 0) >= 0 ? "up" : "down"}`}>{x.uPnl === null ? "—" : money(x.uPnl)}</td>
            </tr>
          ) : (
            <tr key={x.id}>
              <td>{x.instrument}<div className="faint" style={{ fontSize: 10.5 }}>{x.account ?? "tracked setup"}</div></td>
              <td>{x.model ?? "—"}</td>
              <td><Chip tone={x.kind === "paper" ? "acc" : x.gate === "would trade" ? "up" : ""}>{x.kind === "paper" ? "paper trade" : x.gate}</Chip></td>
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
      {d && rows.length > 0 && d.pending.length > 0 && <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>{d.pending.length} paper order{d.pending.length === 1 ? "" : "s"} waiting for a fill: {d.pending.slice(0, 6).map((p) => `${p.instrument} ${p.side} @ ${p.entry}`).join(" · ")}</div>}
      {d && d.tracked.length > 0 && !compact && <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>Tracked setups are logged by the bot and followed on candles without an account order (most were rejected by the gate); they show open R, not money.</div>}
    </Card>
  );
}
