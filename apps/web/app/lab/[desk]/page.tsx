"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  DEFAULT_STRATEGY, DESKS, INSTRUMENTS, TF_MS, breakdown, breakevenWinRate,
  type BacktestResult, type BacktestTrade, type DeskId, type InstrumentId, type StrategyParams,
} from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { fetchHistory } from "@/lib/market";
import type { BacktestRow, Strategy } from "@/lib/types";
import { num, pct, r as fmtR } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Field, Kpi, Note, Seg, Spark, Table, Toggle } from "@/components/ui";

const WINDOWS = [
  { id: "london_q", l: "London Q 02–05 ET" },
  { id: "ny_q", l: "NY Q 07–10 ET" },
  { id: "asia_q", l: "Asia 20–24 ET" },
  { id: "london_close", l: "London close 10–12 ET" },
];
const DAYS = [{ v: "14", l: "14d" }, { v: "30", l: "30d" }, { v: "60", l: "60d" }, { v: "90", l: "90d" }] as const;

/** Warm-up before the test window so structure exists on the first bar. */
const WARM: Record<string, number> = { "1h": 15 * 86_400_000, "4h": 60 * 86_400_000, "15m": 5 * 86_400_000, "5m": 2 * 86_400_000 };

function Breakdown({ title, rows }: { title: string; rows: { key: string; stats: BacktestResult["stats"] }[] }) {
  return (
    <Card span={4} title={title}>
      {rows.length === 0 ? <Empty>No trades</Empty> : (
        <Table head={["", "n", "Win", "Exp", "Net"]} right={[1, 2, 3, 4]}>
          {rows.map((x) => (
            <tr key={x.key}>
              <td>{x.key}{x.stats.n < 20 && <span className="faint" style={{ fontSize: 10.5 }}> · small</span>}</td>
              <td className="r mono">{x.stats.n}</td>
              <td className="r mono">{pct(x.stats.winRate, 0)}</td>
              <td className={`r mono ${x.stats.avgR >= 0 ? "up" : "down"}`}>{fmtR(x.stats.avgR)}</td>
              <td className={`r mono ${x.stats.netR >= 0 ? "up" : "down"}`}>{fmtR(x.stats.netR, 1)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

export default function Lab() {
  const params = useParams<{ desk: string }>();
  const deskId: DeskId = params.desk === "btc" ? "btc" : "gold";
  const desk = DESKS[deskId];
  const [inst, setInst] = useState<InstrumentId>(desk.primary);
  const [days, setDays] = useState<(typeof DAYS)[number]["v"]>("30");
  const [p, setP] = useState<StrategyParams>({ ...DEFAULT_STRATEGY });
  const [name, setName] = useState("Edge v1.1 · Model A");
  const [stratId, setStratId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<(BacktestResult & { source: string; approx: boolean; ms: number }) | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);

  const strategies = useRows<Strategy>({ table: "strategies", eq: ["desk", deskId], order: "updated_at" });
  const runs = useRows<BacktestRow>({ table: "backtests", select: "id,strategy_id,instrument,from_ts,to_ts,params,stats,summary,source,created_at", order: "created_at", limit: 30 });
  useEffect(() => { setInst(desk.primary); setRes(null); setStratId(null); }, [deskId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => worker.current?.terminate(), []);

  const def = INSTRUMENTS[inst];
  const set = <K extends keyof StrategyParams>(k: K, v: StrategyParams[K]) => setP((x) => ({ ...x, [k]: v }));

  const run = async () => {
    setError(null); setRes(null); setSaved(null);
    const to = Date.now();
    const from = to - Number(days) * 86_400_000;
    try {
      setStatus(`Loading ${def.htf} / ${def.poi} / ${def.ltf} history…`);
      const [htf, poi, ltf] = await Promise.all([
        fetchHistory(inst, def.htf, from - WARM[def.htf]!, to),
        fetchHistory(inst, def.poi, from - WARM[def.poi]!, to),
        fetchHistory(inst, def.ltf, from - WARM[def.ltf]!, to),
      ]);
      setStatus(`Replaying ${ltf.candles.length.toLocaleString()} ${def.ltf} bars…`);
      worker.current?.terminate();
      const w = new Worker(new URL("../../../workers/backtest.worker.ts", import.meta.url), { type: "module" });
      worker.current = w;
      w.onmessage = (e: MessageEvent<{ ok: boolean; result?: BacktestResult; error?: string; ms?: number }>) => {
        setStatus(null);
        if (!e.data.ok || !e.data.result) return setError(e.data.error ?? "Backtest failed");
        setRes({ ...e.data.result, source: ltf.source, approx: ltf.approx, ms: e.data.ms ?? 0 });
        w.terminate();
      };
      w.onerror = (e) => { setStatus(null); setError(e.message || "Worker error"); };
      w.postMessage({ instrument: inst, data: { htf: htf.candles, poi: poi.candles, ltf: ltf.candles }, params: p });
    } catch (e) {
      setStatus(null);
      setError((e as Error).message);
    }
  };

  const closed = useMemo(() => (res ? res.trades.filter((t) => t.outcome !== "open") : []), [res]);
  const curve = useMemo(() => { let s = 0; return [0, ...closed.map((t) => (s += t.rNet))]; }, [closed]);
  const by = (k: (t: BacktestTrade) => string) => (res ? breakdown(res.trades, k) : []);

  const saveStrategy = async (asNew: boolean) => {
    const row = { desk: deskId, instrument: inst, name: name.trim() || "Untitled", params: p, updated_at: new Date().toISOString() };
    const q = asNew || !stratId ? supabase.from("strategies").insert(row).select("id").single() : supabase.from("strategies").update(row).eq("id", stratId).select("id").single();
    const { data, error } = await q;
    if (error) return setError(error.message);
    setStratId(data.id);
    strategies.reload();
    setSaved("Strategy saved");
    return data.id as string;
  };
  const saveRun = async () => {
    if (!res) return;
    const id = stratId ?? (await saveStrategy(true));
    if (!id) return;
    const { error } = await supabase.from("backtests").insert({
      strategy_id: id, instrument: inst, from_ts: new Date(res.from).toISOString(), to_ts: new Date(res.to).toISOString(), params: p,
      stats: res.stats, summary: { returnPct: res.returnPct, maxDrawdownPct: res.maxDrawdownPct, signals: res.signals, cancelled: res.cancelled, gross: res.grossStats, days: Number(days) },
      trades: res.trades.slice(0, 500), source: res.source,
    });
    if (error) return setError(error.message);
    runs.reload();
    setSaved("Run saved to the lab history");
  };
  const toAutopilot = async () => {
    const id = stratId ?? (await saveStrategy(true));
    if (!id) return;
    const { error } = await supabase.from("autopilot_config").update({ strategy_id: id, filters: { allowGradeA: p.allowGradeA, windows: p.windows, minRR: p.minRR }, updated_at: new Date().toISOString() }).eq("instrument", inst);
    setSaved(error ? error.message : `Autopilot for ${inst} now uses “${name}” (windows, min R:R, grade A)`);
  };

  const s = res?.stats;
  const be = breakevenWinRate(p.minRR, closed.length ? closed.reduce((a, t) => a + t.costR, 0) / closed.length : 0);

  return (
    <>
      <ErrorNote error={error || strategies.error} />
      {saved && <Note tone="up">{saved}</Note>}
      <div className="g12">
        <Card span={4} title={`${desk.name.replace(" desk", "")} strategy`} right={<Chip tone="acc">{stratId ? "saved" : "new"}</Chip>}>
          <div className="col" style={{ gap: 10 }}>
            <Seg label="Instrument" value={inst} onChange={(v) => { setInst(v); setRes(null); }} options={desk.instruments.map((id) => ({ v: id, l: INSTRUMENTS[id].short }))} />
            <Field label="Name" txt><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            {(strategies.rows ?? []).length > 0 && (
              <div className="fld"><span>Load saved</span>
                <div className="inp"><select value={stratId ?? ""} onChange={(e) => { const st = (strategies.rows ?? []).find((x) => x.id === e.target.value); if (st) { setStratId(st.id); setName(st.name); setP({ ...DEFAULT_STRATEGY, ...(st.params as Partial<StrategyParams>) }); if (st.instrument in INSTRUMENTS) setInst(st.instrument as InstrumentId); } else setStratId(null); }}>
                  <option value="">—</option>{(strategies.rows ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.instrument}</option>)}
                </select></div>
              </div>
            )}
            <div className="between"><span className="lbl">Sides</span><Seg label="Sides" value={p.sides} onChange={(v) => set("sides", v)} options={[{ v: "both", l: "Both" }, { v: "long", l: "Long" }, { v: "short", l: "Short" }]} /></div>
            <div className="lbl-u">Session windows</div>
            <div className="row" style={{ gap: 6 }}>
              {WINDOWS.map((w) => <button key={w.id} type="button" className={`chip ${p.windows.includes(w.id) ? "acc" : ""}`} onClick={() => set("windows", p.windows.includes(w.id) ? p.windows.filter((x) => x !== w.id) : [...p.windows, w.id])}>{w.l}</button>)}
            </div>
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 8 }}>
              <Field label="Min R:R"><input inputMode="decimal" value={p.minRR} onChange={(e) => set("minRR", Number(e.target.value) || 0)} /></Field>
              <Field label="Risk per trade" unit="%"><input inputMode="decimal" value={p.riskPct} onChange={(e) => set("riskPct", Number(e.target.value) || 0)} /></Field>
              <Field label="Max trades / day"><input inputMode="numeric" value={p.maxTradesPerDay} onChange={(e) => set("maxTradesPerDay", Number(e.target.value) || 1)} /></Field>
              <Field label="Stop after losses"><input inputMode="numeric" value={p.stopAfterLosses} onChange={(e) => set("stopAfterLosses", Number(e.target.value) || 1)} /></Field>
              <Field label="Order life" unit="bars"><input inputMode="numeric" value={p.expiryBars} onChange={(e) => set("expiryBars", Number(e.target.value) || 1)} /></Field>
              <Field label="Breakeven at" unit="R"><input inputMode="decimal" placeholder="off" value={p.breakevenAtR ?? ""} onChange={(e) => set("breakevenAtR", e.target.value ? Number(e.target.value) : null)} /></Field>
              <Field label="Cost / round trip" unit="%"><input inputMode="decimal" placeholder={(def.costRate * 100).toFixed(3)} value={p.costRate !== null ? p.costRate * 100 : ""} onChange={(e) => set("costRate", e.target.value ? Number(e.target.value) / 100 : null)} /></Field>
              <Field label="Min stop" unit="%"><input inputMode="decimal" placeholder={def.minStopPct ? String(def.minStopPct) : "none"} value={p.minStopPct ?? ""} onChange={(e) => set("minStopPct", e.target.value ? Number(e.target.value) : null)} /></Field>
            </div>
            <div className="between"><span style={{ fontSize: 12.5 }}>Take grade A (one soft miss)</span><Toggle on={p.allowGradeA} onChange={(v) => set("allowGradeA", v)} label="Allow grade A" /></div>
            <div className="between"><span style={{ fontSize: 12.5 }}>Require price in a 15M POI</span><Toggle on={p.requirePoi} onChange={(v) => set("requirePoi", v)} label="Require POI" /></div>
            <div className="between"><span className="lbl">History</span><Seg label="Days" value={days} onChange={setDays} options={DAYS} /></div>
            <button className="btn pri block" onClick={run} disabled={!!status || !p.windows.length}>{status ? "Running…" : "Run backtest"}</button>
            {status && <p className="faint" style={{ fontSize: 12 }}>{status}</p>}
            <div className="row">
              <button className="btn sm" onClick={() => saveStrategy(false)}>Save</button>
              <button className="btn sm" onClick={() => saveStrategy(true)}>Save as new</button>
              <button className="btn sm" onClick={toAutopilot}>Use for autopilot</button>
            </div>
          </div>
        </Card>

        <section className="s8 col" style={{ gap: 16 }}>
          {!res ? (
            <Card title="Results">
              <Empty>Pick an instrument and range, then run. The replay uses only candles closed at each bar (no look-ahead), fills limits at the shift zone, checks the stop before the target inside a bar, and charges costs in R.</Empty>
            </Card>
          ) : (
            <>
              {res.approx && <Note tone="warn">Tested on {res.source}, an approximation of the traded price. Add an OANDA or Twelve Data key for broker-grade XAU/USD.</Note>}
              <div className="g12">
                <Kpi span={3} label={`Trades · ${days}d`} value={s!.n} foot={<span className="faint">{res.signals} signals · {res.cancelled.ranAway} ran away · {res.cancelled.expired + res.cancelled.windowClosed} expired</span>} />
                <Kpi span={3} label="Win rate" value={pct(s!.winRate, 1)} tone={s!.winRate >= be ? "up" : "down"} foot={<span className="faint">break-even {pct(be, 1)} incl. costs</span>} />
                <Kpi span={3} label="Expectancy (net)" value={fmtR(s!.avgR)} tone={s!.avgR >= 0 ? "up" : "down"} foot={<span className="faint">gross {fmtR(res.grossStats.avgR)} · PF {s!.profitFactor !== null ? num(s!.profitFactor, 2) : "—"}</span>} />
                <Kpi span={3} label="Net R · return" value={fmtR(s!.netR, 1)} tone={s!.netR >= 0 ? "up" : "down"} foot={<span className="faint">{res.returnPct >= 0 ? "+" : ""}{res.returnPct.toFixed(1)}% at {p.riskPct}% · max DD {res.maxDrawdownPct.toFixed(1)}%</span>} />
              </div>
              <Card title="Equity in R (net of costs)" right={<><Chip>{res.source}</Chip><Chip>{(res.ms / 1000).toFixed(1)} s</Chip><button className="btn sm pri" onClick={saveRun}>Save run</button></>}>
                <Spark values={curve} height={180} empty="No closed trades in this window" />
                <div className="row faint mono" style={{ fontSize: 11.5, marginTop: 6, gap: 14 }}>
                  <span>max DD {num(s!.maxDrawdownR, 1)}R</span><span>longest losing streak {s!.longestLosingStreak}</span><span>avg win {fmtR(s!.avgWin)}</span><span>Sharpe/trade {s!.sharpePerTrade !== null ? num(s!.sharpePerTrade, 2) : "—"}</span>
                  {s!.n < 30 && <span className="warn">fewer than 30 trades — not enough to judge</span>}
                </div>
                {Object.keys(res.rejected).length > 0 && (
                  <>
                    <div className="lbl-u" style={{ margin: "12px 0 4px" }}>Why the other {Object.values(res.rejected).reduce((a, b) => a + b, 0)} signals were skipped</div>
                    {Object.entries(res.rejected).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => (
                      <div key={k} className="between" style={{ fontSize: 12, padding: "3px 0" }}><span className="muted">{k}</span><span className="mono">{n}</span></div>
                    ))}
                  </>
                )}
              </Card>
            </>
          )}
        </section>
      </div>

      {res && (
        <>
          <div className="g12">
            <Breakdown title="By session" rows={by((t) => (WINDOWS.find((w) => w.id === t.window)?.l.split(" ").slice(0, 2).join(" ") ?? t.window))} />
            <Breakdown title="By side" rows={by((t) => t.side)} />
            <Breakdown title="By sweep" rows={by((t) => t.sweep)} />
            <Breakdown title="By weekday" rows={by((t) => t.weekday)} />
            <Breakdown title="By NY hour" rows={by((t) => `${String(t.hourNy).padStart(2, "0")}:00`)} />
            <Breakdown title="By target" rows={by((t) => t.targetLabel)} />
          </div>
          <Card title={`Trades · ${res.trades.length}`}>
            <Table head={["Signal (IST)", "Side", "Entry", "Stop", "Target", "Exit", "Planned", "Net R", "Window", "Sweep", "Grade"]} right={[2, 3, 4, 5, 6, 7]}>
              {[...res.trades].reverse().slice(0, 200).map((t) => (
                <tr key={`${t.signalAt}${t.side}`}>
                  <td className="mono faint">{new Date(t.signalAt).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                  <td><Chip tone={t.side === "long" ? "up" : "down"}>{t.side}</Chip></td>
                  <td className="r mono">{num(t.entry, def.digits)}</td>
                  <td className="r mono">{num(t.stop, def.digits)}</td>
                  <td className="r mono">{num(t.target, def.digits)}</td>
                  <td className="r mono">{t.exit !== null ? num(t.exit, def.digits) : "open"}</td>
                  <td className="r mono">{num(t.plannedR, 2)}</td>
                  <td className={`r mono ${t.rNet > 0 ? "up" : t.rNet < 0 ? "down" : ""}`}>{t.outcome === "open" ? "—" : fmtR(t.rNet)}</td>
                  <td>{t.window}</td><td>{t.sweep}</td><td>{t.grade}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}

      <Card title="Lab history" right={<Chip>{TF_MS[def.ltf] / 60000}m replay · latest 30</Chip>}>
        {(runs.rows ?? []).filter((x) => desk.instruments.includes(x.instrument as InstrumentId)).length === 0 ? <Empty>No saved runs yet</Empty> : (
          <Table head={["Saved", "Strategy", "Instrument", "Days", "Trades", "Win", "Exp", "Net R", "Return", "Max DD"]} right={[3, 4, 5, 6, 7, 8, 9]}>
            {(runs.rows ?? []).filter((x) => desk.instruments.includes(x.instrument as InstrumentId)).map((x) => {
              const st = x.stats as { n?: number; winRate?: number; avgR?: number; netR?: number };
              const sm = x.summary as { returnPct?: number; maxDrawdownPct?: number; days?: number };
              return (
                <tr key={x.id}>
                  <td className="mono faint">{new Date(x.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</td>
                  <td>{(strategies.rows ?? []).find((s2) => s2.id === x.strategy_id)?.name ?? "—"}</td>
                  <td>{x.instrument}</td>
                  <td className="r mono">{sm.days ?? "—"}</td>
                  <td className="r mono">{st.n ?? 0}</td>
                  <td className="r mono">{pct(st.winRate ?? 0, 0)}</td>
                  <td className={`r mono ${(st.avgR ?? 0) >= 0 ? "up" : "down"}`}>{fmtR(st.avgR ?? 0)}</td>
                  <td className={`r mono ${(st.netR ?? 0) >= 0 ? "up" : "down"}`}>{fmtR(st.netR ?? 0, 1)}</td>
                  <td className="r mono">{sm.returnPct !== undefined ? `${sm.returnPct.toFixed(1)}%` : "—"}</td>
                  <td className="r mono">{sm.maxDrawdownPct !== undefined ? `${sm.maxDrawdownPct.toFixed(1)}%` : "—"}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
