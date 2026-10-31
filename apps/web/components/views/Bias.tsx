"use client";

import { useMemo, useState } from "react";
import { atr, dailyBias, equalLevels, pivots, type BiasResult } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { useMarket, type MarketData } from "@/lib/useMarket";
import { analyze, type Analysis } from "@/lib/analyze";
import { INSTRUMENT_TF } from "@/lib/market";
import { istDay, todayIst } from "@/lib/derive";
import type { NewsEvent, Signal, Trade, TradingAccount } from "@/lib/types";
import { num, timeShort, toNum } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Note } from "@/components/ui";

type Saved = { id: string; instrument: string; report_date: string; narrative: "continuation" | "pullback"; target: number | null; invalidation: number | null; allowed: "long" | "short" | null; notes: string | null };

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "28px minmax(0,1fr)", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
      <span style={{ width: 28, height: 28, borderRadius: 9, background: "var(--accent-bg)", color: "var(--accent-ink)", display: "grid", placeItems: "center", fontFamily: "var(--font-geist-mono)", fontWeight: 600, fontSize: 12 }}>{n}</span>
      <div className="col" style={{ gap: 5 }}><b style={{ fontSize: 13 }}>{title}</b>{children}</div>
    </div>
  );
}

function compute(inst: string, m: MarketData | null, saved: Saved | null, edit: { target: string; invalidation: string; narrative: "" | "continuation" | "pullback" }) {
  if (!m) return null;
  const long = analyze("long", m.htf, m.poi, m.ltf, [], inst);
  if (!long.range) return { a: long, b: null as BiasResult | null, narrative: "continuation" as const };
  const tol = atr(m.htf, 14) * 0.1;
  const eq = equalLevels(pivots(m.htf, 3, 3), tol);
  const eqh = eq.filter((e) => e.kind === "EQH" && e.level > long.price).pop()?.level;
  const eql = eq.filter((e) => e.kind === "EQL" && e.level < long.price).pop()?.level;
  const auto = long.poiTrend && long.htfTrend && long.poiTrend !== long.htfTrend ? "pullback" : "continuation";
  const narrative = edit.narrative || saved?.narrative || auto;
  const pre = dailyBias({ range: long.range, price: long.price, htfTrend: long.htfTrend, liquidity: { pdh: long.pdh ?? undefined, pdl: long.pdl ?? undefined, eqh, eql }, narrative, target: null, invalidation: null });
  const side = pre.allowed;
  const a = side === "short" ? analyze("short", m.htf, m.poi, m.ltf, [], inst) : long;
  const target = toNum(edit.target) || (saved?.target ?? null) || pre.magnet?.level || null;
  const invalidation = toNum(edit.invalidation) || (saved?.invalidation ?? null) || (side === "long" ? long.range.low : side === "short" ? long.range.high : null);
  const b = dailyBias({ range: long.range, price: long.price, htfTrend: long.htfTrend, liquidity: { pdh: long.pdh ?? undefined, pdl: long.pdl ?? undefined, eqh, eql }, narrative, target, invalidation });
  return { a, b, narrative };
}

function Report({ inst, m, saved, onSaved }: { inst: string; m: MarketData | null; saved: Saved | null; onSaved: () => void }) {
  const [edit, setEdit] = useState<{ target: string; invalidation: string; narrative: "" | "continuation" | "pullback" }>({ target: "", invalidation: "", narrative: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const r = useMemo(() => compute(inst, m, saved, edit), [inst, m, saved, edit]);
  const tf = INSTRUMENT_TF[inst]!;
  if (!r) return <Card span={6} title={inst}><Empty>Loading candles…</Empty></Card>;
  const { a, b } = r;
  if (!b || !a.range) return <Card span={6} title={inst}><Empty>No HTF break of structure in view yet</Empty></Card>;

  const save = async () => {
    const { error } = await supabase.from("bias_reports").upsert({
      report_date: todayIst(), instrument: inst, range_low: a.range!.low, range_high: a.range!.high, price: a.price, htf_trend: a.htfTrend,
      liquidity: Object.fromEntries(b.pools.map((p) => [p.label, p.level])), narrative: r.narrative, target: b.magnet?.level ?? null,
      invalidation: toNum(edit.invalidation) || saved?.invalidation || (b.allowed === "long" ? a.range!.low : b.allowed === "short" ? a.range!.high : null),
      allowed: b.allowed, zone: b.zone,
    }, { onConflict: "report_date,instrument" });
    setMsg(error ? error.message : "Saved");
    if (!error) onSaved();
  };

  return (
    <div className="card s6">
      <div className="ch"><h3 style={{ fontSize: 15 }}>{inst}</h3><span className="faint" style={{ fontSize: 12 }}>{tf.label}</span><span className="sp" />
        <Chip tone={b.allowed === "long" ? "up" : b.allowed === "short" ? "down" : ""}>{b.allowed ? b.allowed.toUpperCase() : "STAND ASIDE"}</Chip>
        {saved && <Chip tone="acc">saved</Chip>}
      </div>
      <Step n={1} title="HTF range">
        <span className="muted" style={{ fontSize: 12.5 }}>{a.htfTrend ? `${tf.htf.toUpperCase()} ${a.htfTrend}trend` : "No trend"} · latest break of structure</span>
        <span className="mono" style={{ fontSize: 12 }}>Swing L {num(a.range.low, 2)} · Swing H {num(a.range.high, 2)}</span>
      </Step>
      <Step n={2} title="Premium / discount">
        <div style={{ position: "relative", height: 30, borderRadius: 10, overflow: "hidden", display: "grid", gridTemplateColumns: "1fr 1fr" }}>
          <span style={{ display: "flex", alignItems: "center", padding: "0 10px", fontSize: 11, fontWeight: 600, letterSpacing: ".06em", background: "var(--up-bg)", color: "var(--up)" }}>DISCOUNT · longs</span>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 10px", fontSize: 11, fontWeight: 600, letterSpacing: ".06em", background: "var(--down-bg)", color: "var(--down)" }}>PREMIUM · shorts</span>
          <b style={{ position: "absolute", top: -2, bottom: -2, width: 3, background: "var(--text)", borderRadius: 2, left: `${Math.max(0, Math.min(100, b.pos))}%` }} />
        </div>
        <span className="mono" style={{ fontSize: 12 }}>EQ {num(b.eq, 2)} · price {num(a.price, 2)} · {b.outside ? `${b.outside} the range` : b.zone}</span>
      </Step>
      <Step n={3} title="Liquidity & magnet">
        <div className="row" style={{ gap: 6 }}>{b.pools.map((p) => <Chip key={p.label} tone={p.side === "buy_side" ? "warn" : "info"}>{p.label} {num(p.level, 2)}</Chip>)}</div>
        <span className="muted" style={{ fontSize: 12.5 }}>Magnet: <b className="acc">{b.magnet ? `${b.magnet.label} ${num(b.magnet.level, 2)}` : "—"}</b></span>
      </Step>
      <Step n={4} title="Narrative">
        <div className="seg">
          {(["continuation", "pullback"] as const).map((n) => <button key={n} type="button" className={r.narrative === n ? "on" : ""} onClick={() => setEdit({ ...edit, narrative: n })}>{n === "continuation" ? "Continuation" : "Pullback"}</button>)}
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>{r.narrative === "continuation" ? "Trade with the internal order flow." : "Wait for the extreme zone, then a shift."}</span>
      </Step>
      <Step n={5} title="Target & invalidation">
        <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 8 }}>
          <label className="fld"><span>Target</span><div className="inp"><input inputMode="decimal" placeholder={b.magnet ? String(b.magnet.level) : ""} value={edit.target} onChange={(e) => setEdit({ ...edit, target: e.target.value })} /></div></label>
          <label className="fld"><span>Invalidation</span><div className="inp"><input inputMode="decimal" placeholder={String(b.allowed === "short" ? a.range.high : a.range.low)} value={edit.invalidation} onChange={(e) => setEdit({ ...edit, invalidation: e.target.value })} /></div></label>
        </div>
        {b.statement && <span style={{ fontSize: 12.5 }}>{b.statement.replace(/(\d[\d,.]*)$/, "")}<b className="mono down">{b.statement.match(/(\d[\d,.]*)$/)?.[1]}</b> on the {tf.htf.toUpperCase()}.</span>}
        {b.issues.map((i) => <Chip key={i} tone="warn">{i}</Chip>)}
      </Step>
      <Step n={6} title="15M POIs">
        {a.zones.length === 0 ? <span className="faint" style={{ fontSize: 12.5 }}>No fresh 15M zones on the allowed side</span> : a.zones.slice(0, 4).map((z, i) => (
          <div key={i} className="between" style={{ fontSize: 12.5 }}><span><Chip tone={z.side === "long" ? "up" : "down"}>{z.label}</Chip> <span className="mono">{num(z.bottom, 2)}–{num(z.top, 2)}</span></span><span className="faint">{z.liquidityStory ? "swept liquidity" : z.fresh ? "fresh" : "touched"}</span></div>
        ))}
      </Step>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn pri sm" onClick={save}>{saved ? "Update today's bias" : "Save today's bias"}</button>
        {msg && <span className={msg === "Saved" ? "up" : "down"} style={{ fontSize: 12 }}>{msg}</span>}
      </div>
    </div>
  );
}

export default function Bias() {
  const xau = useMarket("XAUUSD");
  const btc = useMarket("BTCUSDT.P");
  const saved = useRows<Saved>({ table: "bias_reports", eq: ["report_date", todayIst()] });
  const news = useRows<NewsEvent>({ table: "news_events", order: "at", ascending: true, limit: 60 });
  const signals = useRows<Signal>({ table: "signals", order: "created_at", limit: 20 });
  const trades = useRows<Trade>({ table: "trades", select: "id,account_id,opened_at,instrument", limit: 2000 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,type" });

  const reads = [
    { i: "XAUUSD", r: compute("XAUUSD", xau.data, (saved.rows ?? []).find((s) => s.instrument === "XAUUSD") ?? null, { target: "", invalidation: "", narrative: "" }) },
    { i: "BTCUSDT.P", r: compute("BTCUSDT.P", btc.data, (saved.rows ?? []).find((s) => s.instrument === "BTCUSDT.P") ?? null, { target: "", invalidation: "", narrative: "" }) },
  ];
  const sentence = reads.map(({ i, r }) => {
    if (!r?.b) return null;
    const b = r.b, a = r.a as Analysis;
    if (!b.allowed) return `${i} is ${b.outside ? `${b.outside} its HTF range` : b.zone === "mid" ? "mid-range" : "counter to its HTF trend"} — stand aside.`;
    return `${i}: ${a.htfTrend ?? "no"} HTF trend, price in ${b.zone}, so only ${b.allowed}s${b.magnet ? `; draw is ${b.magnet.label} ${num(b.magnet.level, 2)}` : ""}${a.sweep ? `; ${a.sweep.label} ${num(a.sweep.level, 2)} already swept` : ""}.`;
  }).filter(Boolean).join(" ");

  const master = new Set((accounts.rows ?? []).filter((a) => a.type === "master").map((a) => a.id));
  const masterTrades = (trades.rows ?? []).filter((t) => master.has(t.account_id));
  const todayCount = masterTrades.filter((t) => istDay(t.opened_at) === todayIst()).length;
  const armed = (signals.rows ?? []).find((s) => istDay(s.created_at) === todayIst() && s.state === "ARMED");
  const upcoming = (news.rows ?? []).filter((n) => n.impact === "high" && +new Date(n.at) > Date.now() - 15 * 60_000).slice(0, 4);
  const todayBlocks = upcoming.filter((n) => istDay(n.at) === todayIst());

  return (
    <>
      <ErrorNote error={xau.error || btc.error || saved.error} />
      <section className="card" style={{ padding: 20 }}>
        <div className="g12" style={{ alignItems: "center" }}>
          <div className="s8 col" style={{ gap: 8 }}>
            <span className="lbl-u">Today&apos;s read</span>
            <p style={{ fontSize: 16, lineHeight: 1.55, textWrap: "pretty" }}>{sentence || "Waiting for market data…"}{todayBlocks.length ? ` ${todayBlocks.length} high-impact release${todayBlocks.length > 1 ? "s" : ""} today.` : " Nothing high-impact today."}</p>
            <span className="faint" style={{ fontSize: 11.5 }}>Generated from engine output · closed candles only</span>
          </div>
          <div className="s4 auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            {reads.map(({ i, r }) => (
              <div key={i} className="card" style={{ background: "var(--surface-2)" }}>
                <div className="lbl">{i}</div>
                <div className={`kv sm ${r?.b?.allowed === "long" ? "up" : r?.b?.allowed === "short" ? "down" : ""}`}>{r?.b?.allowed ? r.b.allowed.toUpperCase() : r?.b ? "STAND ASIDE" : "—"}</div>
                <div className="faint" style={{ fontSize: 11.5 }}>{r?.narrative ?? ""}</div>
              </div>
            ))}
            <div className="card" style={{ background: "var(--surface-2)" }}><div className="lbl">Window</div><div className="kv sm">NY Q</div><div className="faint" style={{ fontSize: 11.5 }}>London Q for model F</div></div>
            <div className="card" style={{ background: "var(--surface-2)" }}><div className="lbl">A+ today</div><div className="kv sm">{todayCount} / 2</div><div className="faint" style={{ fontSize: 11.5 }}>master</div></div>
          </div>
        </div>
      </section>

      <section className="g12">
        {reads.map(({ i }) => <Report key={i} inst={i} m={i === "XAUUSD" ? xau.data : btc.data} saved={(saved.rows ?? []).find((s) => s.instrument === i) ?? null} onSaved={saved.reload} />)}
      </section>

      <section className="g12">
        <Card span={7} title={`Pre-trade card${armed ? ` · ${armed.instrument}` : ""}`} right={armed ? <Chip tone="solid">{armed.state} · {armed.grade}</Chip> : null}>
          {!armed ? <Empty>No armed signal today</Empty> : (
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))" }}>
              <div><div className="lbl">Window</div><b>{armed.session_window === "ny_q" ? "NY Q" : armed.session_window === "london_q" ? "London Q" : "—"}</b></div>
              <div><div className="lbl">Model</div><b>{armed.model}</b></div>
              <div><div className="lbl">Side</div><b className={armed.side === "long" ? "up" : "down"}>{armed.side}</b></div>
              <div><div className="lbl">Entry / SL / TP</div><b className="mono">{num(Number(armed.entry), 2)} / {num(Number(armed.stop), 2)} / {num(Number(armed.target), 2)}</b></div>
              <div><div className="lbl">R:R</div><b className="mono">{armed.rr ? num(Number(armed.rr), 2) : "—"}</b></div>
              <div><div className="lbl">A+ trades today</div><b className="mono">{todayCount} / 2</b></div>
            </div>
          )}
        </Card>
        <Card span={5} title="Today's no-trade blocks">
          <div className="col" style={{ gap: 8 }}>
            {todayBlocks.length === 0 && <div className="between"><span style={{ fontSize: 12.5 }}>No high-impact events today</span><Chip tone="up">clear</Chip></div>}
            {upcoming.map((n) => {
              const t = +new Date(n.at);
              return (
                <div key={n.id} className="between"><span style={{ fontSize: 12.5 }}>{new Date(t).toLocaleDateString("en-GB", { weekday: "short", timeZone: "America/New_York" })} · {n.title} {timeShort(t, "America/New_York")} ET</span><span className="mono faint" style={{ fontSize: 12 }}>{timeShort(t - 900_000, "America/New_York")}–{timeShort(t + 900_000, "America/New_York")} ET</span></div>
              );
            })}
            <div className="divider" />
            <p className="muted" style={{ fontSize: 12 }}>Max 2 A+ per instrument · stop after 2 losses · set-and-forget (trade {Math.min(masterTrades.length + 1, 30)} of 30) · no TP stretch · ≥3R.</p>
          </div>
        </Card>
      </section>
      {saved.rows && saved.rows.length === 2 && <Note tone="up">Both biases saved for today — the copilot uses them for direction.</Note>}
    </>
  );
}
