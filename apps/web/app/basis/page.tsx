"use client";

import { useCallback, useEffect, useState } from "react";
import { staffGet, staffPost } from "@/lib/market";
import { money, num, pct, r as fmtR } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Kpi, Note, Table, Toggle } from "@/components/ui";
import Sparkline from "@/components/Sparkline";

/**
 * Funding basis trade (cash-and-carry) on paper: long spot + short perp of equal size. While funding is
 * positive the longs pay the shorts, so the short collects it; the bot closes when funding turns negative.
 * P&L, APR and R (net ÷ round-trip cost) are tracked apart from the trading accounts.
 */

interface Pnl { spot: number; perp: number; basis: number; funding: number; fees: number; net: number; r: number; apr: number; days: number; cost: number }
interface Row {
  symbol: string; spot: number | null; mark: number; index: number; basisPct: number | null; predicted: number; nextFundingAt: number;
  lastSettled: number | null; avg3d: number | null; avg7d: number | null; apr: number; avgApr7d: number | null; breakEven: number | null;
  history: { t: number; rate: number }[]; signal: "enter" | "hold" | "exit" | "wait"; open: boolean;
}
interface Pos {
  id: string; symbol: string; status: string; qty: number; notional: number; spot_entry: number; perp_entry: number; spot_exit: number | null; perp_exit: number | null;
  entry_rate: number | null; funding_count: number; opened_at: string; closed_at: string | null; exit_reason: string | null; source: string; pnl: Pnl;
}
interface Config { enabled: boolean; mode: "off" | "paper"; symbols: string[]; notional: number; entry_rate: number; exit_rate: number; max_open: number; spot_fee: number; perp_fee: number }
interface Data { at: number; config: Config; board: Row[]; open: Pos[]; closed: Pos[]; totals: { openNet: number; openFunding: number; closedNet: number; closedFunding: number; closedFees: number; closedBasis: number; closedR: number; closedCount: number; winRate: number | null } }

const rate = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(4)}%`);
const SIGNAL: Record<Row["signal"], { l: string; tone: "up" | "down" | "info" | "" }> = { enter: { l: "enter", tone: "up" }, hold: { l: "holding", tone: "info" }, exit: { l: "exit", tone: "down" }, wait: { l: "wait", tone: "" } };
const countdown = (t: number, now: number) => {
  const m = Math.max(0, Math.round((t - now) / 60_000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const ist = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export default function Basis() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [form, setForm] = useState<{ symbols: string; notional: string; entry: string; exit: string; maxOpen: string; spotFee: string; perpFee: string } | null>(null);

  const load = useCallback(async () => {
    try { const x = await staffGet<Data>("/api/basis"); setD(x); setError(null); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 10_000);
    const c = setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearInterval(t); clearInterval(c); };
  }, [load]);
  useEffect(() => {
    if (d && !form) setForm({
      symbols: d.config.symbols.join(", "), notional: String(d.config.notional), entry: String(d.config.entry_rate * 100), exit: String(d.config.exit_rate * 100),
      maxOpen: String(d.config.max_open), spotFee: String(d.config.spot_fee * 100), perpFee: String(d.config.perp_fee * 100),
    });
  }, [d, form]);

  const act = async (label: string, body: unknown) => {
    setBusy(label); setNote(null);
    try { const r = await staffPost<{ ok: boolean; note?: string }>("/api/basis", body); setNote(r.note ?? `${label} done`); await load(); }
    catch (e) { setError((e as Error).message); }
    setBusy(null);
  };
  const saveConfig = () => form && act("Settings saved", { action: "config", patch: {
    symbols: form.symbols.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
    notional: Number(form.notional), entry_rate: Number(form.entry) / 100, exit_rate: Number(form.exit) / 100, max_open: Number(form.maxOpen),
    spot_fee: Number(form.spotFee) / 100, perp_fee: Number(form.perpFee) / 100,
  } });

  const t = d?.totals;
  const cfg = d?.config;
  return (
    <>
      <ErrorNote error={error} />
      {note && <Note tone="up">{note}</Note>}
      <section className="card" style={{ padding: 14 }}>
        <p style={{ fontSize: 13, margin: 0 }}>
          <b>Cash-and-carry:</b> buy spot and short the perpetual in the same size, so price moves cancel. While funding is positive the
          longs pay the shorts every 8 hours and the short collects it. The bot enters when the predicted rate is at least the entry
          threshold and the 3-day average is positive, books each settlement, and closes both legs when funding turns negative.
          <span className="faint"> R = net ÷ round-trip cost (both legs in and out). Paper only.</span>
        </p>
      </section>

      <section className="g12">
        <Kpi span={3} label="Open positions" value={d ? d.open.length : "—"} foot={<span className="faint">{t ? `funding ${money(t.openFunding)} · net ${money(t.openNet)}` : ""}</span>} tone={t && t.openNet < 0 ? "down" : ""} />
        <Kpi span={3} label="Closed net P&L" value={t ? money(t.closedNet) : "—"} tone={t ? (t.closedNet >= 0 ? "up" : "down") : ""} foot={<span className="faint">{t ? `funding ${money(t.closedFunding)} · basis ${money(t.closedBasis)} · fees ${money(t.closedFees)}` : ""}</span>} />
        <Kpi span={3} label="Closed R" value={t && t.closedCount ? fmtR(t.closedR) : "—"} tone={t ? (t.closedR >= 0 ? "up" : "down") : ""} foot={<span className="faint">{t ? `${t.closedCount} closed · ${t.winRate === null ? "—" : pct(t.winRate, 0)} net positive` : ""}</span>} />
        <Kpi span={3} label="Bot" value={cfg ? (cfg.enabled && cfg.mode === "paper" ? "Paper · on" : "Off") : "—"} foot={cfg ? <span className="faint">{cfg.symbols.length} symbols · enter ≥ {rate(cfg.entry_rate)} · exit &lt; {rate(cfg.exit_rate)}</span> : null} />
      </section>

      <Card title="Live funding board" right={<div className="row" style={{ gap: 6 }}><Chip dot tone="info">Binance USDⓈ-M · {d ? new Date(d.at).toLocaleTimeString("en-GB") : "…"}</Chip><button className="btn sm" disabled={!!busy} onClick={() => act("Pass", { action: "run" })}>{busy === "Pass" ? "Running…" : "Run bot now"}</button></div>}>
        {!d ? <Empty>Loading funding…</Empty> : (
          <Table head={["Symbol", "Spot", "Perp mark", "Basis", "Predicted", "APR", "7d avg APR", "Last settled", "Next in", "7 days", "Break-even", "Signal", ""]} right={[1, 2, 3, 4, 5, 6, 7, 8, 10]}>
            {d.board.map((r) => (
              <tr key={r.symbol}>
                <td><b style={{ fontWeight: 500 }}>{r.symbol.replace("USDT", "")}</b><span className="faint">/USDT</span></td>
                <td className="r mono">{r.spot === null ? "—" : num(r.spot, r.spot < 10 ? 4 : 2)}</td>
                <td className="r mono">{num(r.mark, r.mark < 10 ? 4 : 2)}</td>
                <td className={`r mono ${(r.basisPct ?? 0) >= 0 ? "up" : "down"}`}>{r.basisPct === null ? "—" : `${r.basisPct >= 0 ? "+" : ""}${r.basisPct.toFixed(3)}%`}</td>
                <td className={`r mono ${r.predicted >= 0 ? "up" : "down"}`}>{rate(r.predicted)}</td>
                <td className={`r mono ${r.apr >= 0 ? "up" : "down"}`}>{r.apr.toFixed(1)}%</td>
                <td className="r mono">{r.avgApr7d === null ? "—" : `${r.avgApr7d.toFixed(1)}%`}</td>
                <td className={`r mono ${(r.lastSettled ?? 0) >= 0 ? "" : "down"}`}>{rate(r.lastSettled)}</td>
                <td className="r mono">{countdown(r.nextFundingAt, now)}</td>
                <td><Sparkline values={r.history.map((h) => h.rate)} width={90} zero tone={(r.avg7d ?? 0) >= 0 ? "var(--up)" : "var(--down)"} /></td>
                <td className="r mono" title="Settlements at the predicted rate to repay the round trip">{r.breakEven === null ? "—" : `${r.breakEven} × 8h`}</td>
                <td><Chip tone={SIGNAL[r.signal].tone}>{SIGNAL[r.signal].l}</Chip></td>
                <td>{!r.open && <button className="btn sm" disabled={!!busy} onClick={() => act(`Opened ${r.symbol}`, { action: "open", symbol: r.symbol })}>Open</button>}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Predicted = the rate for the next settlement (positive: longs pay shorts). Basis = perp mark vs spot. Break-even = settlements at the predicted rate needed to repay fees on both legs, in and out.</p>
      </Card>

      <Card title="Open positions" right={<Chip>{d?.open.length ?? 0} open</Chip>}>
        {!d || d.open.length === 0 ? <Empty>No open basis positions</Empty> : (
          <Table head={["Symbol", "Size", "Entry spot / perp", "Opened", "Settlements", "Funding", "Basis P&L", "Fees", "Net", "R", "APR", ""]} right={[1, 4, 5, 6, 7, 8, 9, 10]}>
            {d.open.map((p) => (
              <tr key={p.id}>
                <td>{p.symbol}<div className="faint" style={{ fontSize: 10.5 }}>{p.source} · entry {rate(p.entry_rate)}</div></td>
                <td className="r mono">{money(p.notional, "USD", 0)}<div className="faint" style={{ fontSize: 10.5 }}>{num(p.qty, 4)}</div></td>
                <td className="mono">{num(p.spot_entry, 2)} / {num(p.perp_entry, 2)}</td>
                <td>{ist(p.opened_at)}<div className="faint" style={{ fontSize: 10.5 }}>{p.pnl.days.toFixed(1)}d</div></td>
                <td className="r mono">{p.funding_count}</td>
                <td className={`r mono ${p.pnl.funding >= 0 ? "up" : "down"}`}>{money(p.pnl.funding)}</td>
                <td className={`r mono ${p.pnl.basis >= 0 ? "up" : "down"}`}>{money(p.pnl.basis)}</td>
                <td className="r mono">{money(-p.pnl.fees)}</td>
                <td className={`r mono ${p.pnl.net >= 0 ? "up" : "down"}`}><b>{money(p.pnl.net)}</b></td>
                <td className={`r mono ${p.pnl.r >= 0 ? "up" : "down"}`}>{fmtR(p.pnl.r)}</td>
                <td className="r mono">{(p.pnl.apr * 100).toFixed(1)}%</td>
                <td><button className="btn sm" disabled={!!busy} onClick={() => act(`Closed ${p.symbol}`, { action: "close", id: p.id })}>Close</button></td>
              </tr>
            ))}
          </Table>
        )}
        <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Net includes the fees to close both legs now. 1R = the round-trip cost of the position.</p>
      </Card>

      <div className="g12">
        <Card span={8} title="Closed positions">
          {!d || d.closed.length === 0 ? <Empty>No closed positions yet</Empty> : (
            <Table head={["Symbol", "Opened → closed", "Days", "Settlements", "Funding", "Basis", "Fees", "Net", "R", "APR", "Exit"]} right={[2, 3, 4, 5, 6, 7, 8, 9]}>
              {d.closed.map((p) => (
                <tr key={p.id}>
                  <td>{p.symbol}</td>
                  <td style={{ fontSize: 12 }}>{ist(p.opened_at)} → {ist(p.closed_at)}</td>
                  <td className="r mono">{p.pnl.days.toFixed(1)}</td>
                  <td className="r mono">{p.funding_count}</td>
                  <td className={`r mono ${p.pnl.funding >= 0 ? "up" : "down"}`}>{money(p.pnl.funding)}</td>
                  <td className={`r mono ${p.pnl.basis >= 0 ? "up" : "down"}`}>{money(p.pnl.basis)}</td>
                  <td className="r mono">{money(-p.pnl.fees)}</td>
                  <td className={`r mono ${p.pnl.net >= 0 ? "up" : "down"}`}><b>{money(p.pnl.net)}</b></td>
                  <td className={`r mono ${p.pnl.r >= 0 ? "up" : "down"}`}>{fmtR(p.pnl.r)}</td>
                  <td className="r mono">{(p.pnl.apr * 100).toFixed(1)}%</td>
                  <td className="faint" style={{ fontSize: 11.5 }}>{p.exit_reason ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card span={4} title="Bot settings" right={cfg && <Toggle on={cfg.enabled && cfg.mode === "paper"} onChange={(v) => act(v ? "Bot on" : "Bot off", { action: "config", patch: { enabled: v, mode: v ? "paper" : "off" } })} label="Basis bot" />}>
          {!form ? <Empty>Loading…</Empty> : (
            <div className="col" style={{ gap: 10 }}>
              {([
                ["symbols", "Symbols (comma separated)", ""], ["notional", "Size per position", "USDT"], ["entry", "Enter when predicted ≥", "% / 8h"],
                ["exit", "Exit when funding <", "% / 8h"], ["maxOpen", "Max open positions", ""], ["spotFee", "Spot fee", "%"], ["perpFee", "Perp fee", "%"],
              ] as const).map(([k, l, unit]) => (
                <label key={k} className="fld">
                  <span>{l}{unit && <span className="faint"> · {unit}</span>}</span>
                  <div className={`inp${k === "symbols" ? " txt" : ""}`}><input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></div>
                </label>
              ))}
              <button className="btn pri" disabled={!!busy} onClick={saveConfig}>Save settings</button>
              <p className="faint" style={{ fontSize: 11, margin: 0 }}>0.01% per 8h ≈ 11% APR. Default fees are Binance taker (spot 0.10%, perp 0.05%): about 30 settlements at 0.01% to repay a round trip.</p>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
