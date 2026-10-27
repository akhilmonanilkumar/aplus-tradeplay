"use client";

import { useCallback, useEffect, useState } from "react";
import { staffGet, staffPost } from "@/lib/market";
import { money, num, pct, r as fmtR } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Kpi, Note, Table, Toggle } from "@/components/ui";
import Sparkline from "@/components/Sparkline";

/**
 * Funding basis trade (cash-and-carry) on paper, in its own simulated account: long spot + short perp of
 * equal size. While funding is positive the longs pay the shorts, so the short collects it. Capital is
 * split into spot, futures margin and a reserve; the short's liquidation price and buffer are tracked and
 * margin is topped up from the reserve on a rally. P&L, APR and R (net ÷ round-trip cost) stay separate.
 */

interface Risk { margin: number; liq: number | null; buffer: number | null; initialBuffer: number | null }
interface Pnl { spot: number; perp: number; basis: number; funding: number; fees: number; net: number; r: number; apr: number; days: number; cost: number; risk: Risk }
interface Row {
  symbol: string; spot: number | null; mark: number; index: number; basisPct: number | null; predicted: number; nextFundingAt: number;
  lastSettled: number | null; avg3d: number | null; avg7d: number | null; apr: number; avgApr7d: number | null; breakEven: number | null;
  history: { t: number; rate: number }[]; signal: "enter" | "hold" | "exit" | "wait"; open: boolean;
}
interface Pos {
  id: string; symbol: string; status: string; qty: number; notional: number; spot_entry: number; perp_entry: number; spot_exit: number | null; perp_exit: number | null;
  entry_rate: number | null; funding_count: number; opened_at: string; closed_at: string | null; exit_reason: string | null; source: string; pnl: Pnl;
  margin: number | null; leverage: number | null; top_ups: number; top_up_count: number; max_mark: number | null;
}
interface Config {
  enabled: boolean; mode: "off" | "paper"; symbols: string[]; max_open: number; spot_fee: number; perp_fee: number;
  capital: number; leverage: number; mmr: number; reserve_share: number; rebalance_at: number; min_notional: number; venue: "binance" | "coinswitch"; entry_avg: number; exit_avg: number;
}
interface Account { capital: number; realised: number; equity: number; open: number; reserve: number; reserveUsed: number; reserveLeft: number; slot: { notional: number; spot: number; margin: number } }
interface Data { at: number; config: Config; account: Account; board: Row[]; open: Pos[]; closed: Pos[]; totals: { openNet: number; openFunding: number; closedNet: number; closedFunding: number; closedFees: number; closedBasis: number; closedR: number; closedCount: number; winRate: number | null } }

const rate = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(4)}%`);
const SIGNAL: Record<Row["signal"], { l: string; tone: "up" | "down" | "info" | "" }> = { enter: { l: "enter", tone: "up" }, hold: { l: "holding", tone: "info" }, exit: { l: "exit", tone: "down" }, wait: { l: "wait", tone: "" } };
const countdown = (t: number, now: number) => {
  const m = Math.max(0, Math.round((t - now) / 60_000));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
/** Taker fees per venue. CoinSwitch adds 18% GST on fees; its published rates vary, so confirm on the fee page before going live. */
const VENUES = { binance: { label: "Binance", spot: 0.1, perp: 0.05 }, coinswitch: { label: "CoinSwitch PRO", spot: 0.2 * 1.18, perp: 0.05 * 1.18 } } as const;
type Form = { symbols: string; capital: string; leverage: string; reserve: string; rebalance: string; mmr: string; minNotional: string; entry: string; exit: string; maxOpen: string; spotFee: string; perpFee: string; venue: Config["venue"] };
const ist = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

export default function Basis() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [form, setForm] = useState<Form | null>(null);

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
      symbols: d.config.symbols.join(", "), capital: String(d.config.capital), leverage: String(d.config.leverage), reserve: String(d.config.reserve_share * 100),
      rebalance: String(d.config.rebalance_at * 100), mmr: String(d.config.mmr * 100), minNotional: String(d.config.min_notional),
      entry: String(d.config.entry_avg * 100), exit: String(d.config.exit_avg * 100), maxOpen: String(d.config.max_open),
      spotFee: String(+(d.config.spot_fee * 100).toFixed(4)), perpFee: String(+(d.config.perp_fee * 100).toFixed(4)), venue: d.config.venue,
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
    capital: Number(form.capital), leverage: Number(form.leverage), reserve_share: Number(form.reserve) / 100, rebalance_at: Number(form.rebalance) / 100,
    mmr: Number(form.mmr) / 100, min_notional: Number(form.minNotional), entry_avg: Number(form.entry) / 100, exit_avg: Number(form.exit) / 100,
    max_open: Number(form.maxOpen), spot_fee: Number(form.spotFee) / 100, perp_fee: Number(form.perpFee) / 100, venue: form.venue,
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
          longs pay the shorts every 8 hours and the short collects it. The bot enters when the 7-day funding average is at least the
          entry threshold, books each settlement, and closes both legs when the 7-day average turns negative. It holds through short
          negative runs, because exiting on each one pays the round trip again.
          <span className="faint"> R = net ÷ round-trip cost (both legs in and out). Paper only.</span>
        </p>
      </section>

      {d && (
        <section className="g12">
          <Kpi span={3} label="Account equity" value={money(d.account.equity)} tone={d.account.realised >= 0 ? "up" : "down"} foot={<span className="faint">started {money(d.account.capital, "USD", 0)} · realised {money(d.account.realised)} · {(((d.account.equity + (t?.openNet ?? 0)) / d.account.capital - 1) * 100).toFixed(2)}% incl. open</span>} />
          <Kpi span={3} label="Next position" value={money(d.account.slot.notional, "USD", 0)} foot={<span className="faint">{d.account.slot.notional > 0 ? `spot ${money(d.account.slot.spot, "USD", 0)} · margin ${money(d.account.slot.margin, "USD", 0)} at ${d.config.leverage}×` : "no free slot"}</span>} />
          <Kpi span={3} label="Margin reserve" value={money(d.account.reserveLeft, "USD", 0)} tone={d.account.reserveLeft < d.account.reserve * 0.5 ? "down" : ""} foot={<span className="faint">{(d.config.reserve_share * 100).toFixed(0)}% of equity · {money(d.account.reserveUsed, "USD", 0)} moved to margin</span>} />
          <Kpi span={3} label="Venue" value={VENUES[d.config.venue].label} foot={<span className="faint">fees spot {(d.config.spot_fee * 100).toFixed(3)}% · perp {(d.config.perp_fee * 100).toFixed(3)}% · round trip {(2 * (d.config.spot_fee + d.config.perp_fee) * 100).toFixed(2)}%</span>} />
        </section>
      )}

      <section className="g12">
        <Kpi span={3} label="Open positions" value={d ? d.open.length : "—"} foot={<span className="faint">{t ? `funding ${money(t.openFunding)} · net ${money(t.openNet)}` : ""}</span>} tone={t && t.openNet < 0 ? "down" : ""} />
        <Kpi span={3} label="Closed net P&L" value={t ? money(t.closedNet) : "—"} tone={t ? (t.closedNet >= 0 ? "up" : "down") : ""} foot={<span className="faint">{t ? `funding ${money(t.closedFunding)} · basis ${money(t.closedBasis)} · fees ${money(t.closedFees)}` : ""}</span>} />
        <Kpi span={3} label="Closed R" value={t && t.closedCount ? fmtR(t.closedR) : "—"} tone={t ? (t.closedR >= 0 ? "up" : "down") : ""} foot={<span className="faint">{t ? `${t.closedCount} closed · ${t.winRate === null ? "—" : pct(t.winRate, 0)} net positive` : ""}</span>} />
        <Kpi span={3} label="Bot" value={cfg ? (cfg.enabled && cfg.mode === "paper" ? "Paper · on" : "Off") : "—"} foot={cfg ? <span className="faint">{cfg.symbols.length} symbols · 7d avg ≥ {rate(cfg.entry_avg)} in · &lt; {rate(cfg.exit_avg)} out</span> : null} />
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
          <Table head={["Symbol", "Size", "Entry spot / perp", "Opened", "Settlements", "Funding", "Basis P&L", "Fees", "Net", "R", "APR", "Margin", "Liquidation", "Buffer", ""]} right={[1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]}>
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
                <td className="r mono">{money(p.pnl.risk.margin, "USD", 0)}<div className="faint" style={{ fontSize: 10.5 }}>{p.leverage ?? "—"}×{p.top_up_count ? ` · +${money(p.top_ups, "USD", 0)} ×${p.top_up_count}` : ""}</div></td>
                <td className="r mono">{p.pnl.risk.liq === null ? "—" : num(p.pnl.risk.liq, p.pnl.risk.liq < 10 ? 4 : 2)}</td>
                <td className={`r mono ${p.pnl.risk.buffer !== null && p.pnl.risk.initialBuffer !== null && p.pnl.risk.buffer < p.pnl.risk.initialBuffer * 0.5 ? "down" : ""}`}>{p.pnl.risk.buffer === null ? "—" : `+${(p.pnl.risk.buffer * 100).toFixed(1)}%`}</td>
                <td><button className="btn sm" disabled={!!busy} onClick={() => act(`Closed ${p.symbol}`, { action: "close", id: p.id })}>Close</button></td>
              </tr>
            ))}
          </Table>
        )}
        <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Net includes the fees to close both legs now. 1R = the round-trip cost of the position. Buffer = how far the perp can rise before the short is liquidated; when a rally uses up the rebalance share of it, margin is moved over from the reserve. The spot leg gains what the short loses, so a top-up is a transfer, not a loss.</p>
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
              <label className="fld">
                <span>Venue</span>
                <div className="inp"><select value={form.venue} onChange={(e) => { const v = e.target.value as Config["venue"]; setForm({ ...form, venue: v, spotFee: String(+VENUES[v].spot.toFixed(4)), perpFee: String(+VENUES[v].perp.toFixed(4)) }); }}>
                  {(Object.keys(VENUES) as Config["venue"][]).map((v) => <option key={v} value={v}>{VENUES[v].label}</option>)}
                </select></div>
              </label>
              {([
                ["symbols", "Symbols (comma separated)", ""], ["capital", "Account capital", "USDT"], ["leverage", "Short-leg leverage", "×"],
                ["reserve", "Margin reserve", "% of equity"], ["rebalance", "Top up margin after the rally uses", "% of buffer"], ["mmr", "Maintenance margin", "%"],
                ["minNotional", "Minimum order", "USDT"], ["maxOpen", "Max open positions", ""], ["entry", "Enter when 7d average ≥", "% / 8h"],
                ["exit", "Exit when 7d average <", "% / 8h"], ["spotFee", "Spot fee", "%"], ["perpFee", "Perp fee", "%"],
              ] as const).map(([k, l, unit]) => (
                <label key={k} className="fld">
                  <span>{l}{unit && <span className="faint"> · {unit}</span>}</span>
                  <div className={`inp${k === "symbols" ? " txt" : ""}`}><input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></div>
                </label>
              ))}
              <button className="btn pri" disabled={!!busy} onClick={saveConfig}>Save settings</button>
              <p className="faint" style={{ fontSize: 11, margin: 0 }}>At 1× each position is half spot, half margin: the short survives about a +99% rally before liquidation. 2× survives about +49%, which BTC's worst 30-day rally (+63%) would have broken without top-ups. 0.005% per 8h ≈ 5.5% APR on notional.</p>
            </div>
          )}
        </Card>
      </div>

      <Card title="Research · Binance, Jun 2025 – Oct 2026 (1,500 settlements)">
        <Table head={["Symbol", "Funding > 0", "Mean / 8h", "Exit on any negative", "7-day average rule", "Hold throughout", "Worst 30-day rally", "Max lev. for it"]} right={[1, 2, 3, 4, 5, 6, 7]}>
          {RESEARCH.map((x) => (
            <tr key={x.s}>
              <td>{x.s}</td>
              <td className="r mono">{x.pos}%</td>
              <td className="r mono">{x.mean.toFixed(4)}%</td>
              <td className={`r mono ${x.neg >= 0 ? "up" : "down"}`}>{x.neg > 0 ? "+" : ""}{x.neg.toFixed(1)}%</td>
              <td className={`r mono ${x.avg7 >= 0 ? "up" : "down"}`}>{x.avg7 > 0 ? "+" : ""}{x.avg7.toFixed(1)}%</td>
              <td className={`r mono ${x.hold >= 0 ? "up" : "down"}`}>{x.hold > 0 ? "+" : ""}{x.hold.toFixed(1)}%</td>
              <td className="r mono">+{x.rally}%</td>
              <td className="r mono">{(1 / ((1 + x.rally / 100) * 1.005 - 1)).toFixed(1)}×</td>
            </tr>
          ))}
        </Table>
        <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>
          Net % on notional after Binance taker fees (0.30% per round trip), 16 months. Exiting on the first negative print churns: every
          short dip costs another round trip. Funding has sat near the 0.01% base rate, so carry is thin, about 4% a year on BTC notional,
          or about 2% on capital at 1×. SOL lost under every rule. Rallies are over the last 1,000 daily bars.
        </p>
      </Card>
    </>
  );
}

/** From the lab's basis research run (family=basis), 2025-06-14 → 2026-10-27. */
const RESEARCH = [
  { s: "BTC", pos: 80.7, mean: 0.0037, neg: -2.4, avg7: 4.0, hold: 5.2, rally: 62.9 },
  { s: "ETH", pos: 77.3, mean: 0.003, neg: -5.6, avg7: 2.6, hold: 4.1, rally: 73.7 },
  { s: "BNB", pos: 38.0, mean: 0.0019, neg: 2.4, avg7: 1.6, hold: 2.6, rally: 95.7 },
  { s: "DOGE", pos: 72.7, mean: 0.0036, neg: -16.9, avg7: 2.5, hold: 5.0, rally: 295.1 },
  { s: "XRP", pos: 62.3, mean: 0.0017, neg: -12.6, avg7: 1.6, hold: 2.1, rally: 479.8 },
  { s: "SOL", pos: 59.5, mean: 0.0, neg: -15.0, avg7: -0.7, hold: -0.4, rally: 110.5 },
];
