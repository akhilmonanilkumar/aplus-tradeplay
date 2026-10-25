"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { atr, equalLevels, fairValueGaps, pivots, sessionRange, ASIA_Q, rewardToRisk } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { useMarket } from "@/lib/useMarket";
import { analyze, type Analysis } from "@/lib/analyze";
import { istDay, todayIst } from "@/lib/derive";
import type { SetupZone, Signal } from "@/lib/types";
import { num, pct, timeShort, toNum } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Field, Seg, Table } from "@/components/ui";

type Bias = { instrument: string; allowed: "long" | "short" | null; target: number | null; invalidation: number | null; report_date: string };
const KINDS = ["demand", "supply", "order_block", "fvg", "flip", "institutional"] as const;
const INSTS = ["XAUUSD", "BTCUSDT.P"] as const;

function KCard({ inst, side, children, accent }: { inst: string; side?: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <div style={{ background: "var(--surface)", border: `1px solid ${accent ? "var(--accent)" : "var(--line)"}`, borderRadius: 14, padding: 11, display: "flex", flexDirection: "column", gap: 7 }}>
      <div className="between"><b>{inst}</b>{side && <Chip tone={side === "long" ? "up" : "down"}>{side === "long" ? "Long" : "Short"}</Chip>}</div>
      {children}
    </div>
  );
}

function useDerivs() {
  const [d, setD] = useState<{ funding: number; nextFunding: number; mark: number; last: number; oiChange: number | null; lsr: number | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [pi, tk, oi, ls] = await Promise.all([
          fetch("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT").then((r) => r.json()),
          fetch("https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT").then((r) => r.json()),
          fetch("https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=25").then((r) => r.json()).catch(() => null),
          fetch("https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1").then((r) => r.json()).catch(() => null),
        ]);
        const oiArr = Array.isArray(oi) ? oi as { sumOpenInterest: string }[] : [];
        const first = oiArr[0] ? Number(oiArr[0].sumOpenInterest) : null, lastOi = oiArr.length ? Number(oiArr[oiArr.length - 1]!.sumOpenInterest) : null;
        if (live) setD({
          funding: Number(pi.lastFundingRate), nextFunding: Number(pi.nextFundingTime), mark: Number(pi.markPrice), last: Number(tk.price),
          oiChange: first && lastOi ? (lastOi - first) / first : null,
          lsr: Array.isArray(ls) && ls[0] ? Number(ls[0].longShortRatio) : null,
        });
      } catch (e) { if (live) setErr((e as Error).message); }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return { d, err };
}

function stage(a: Analysis | null) {
  if (!a) return -1;
  if (a.shift?.t) return 3;
  if (a.sweep) return 2;
  if (a.inside) return 1;
  return 0;
}

export default function Setups() {
  const zones = useRows<SetupZone>({ table: "setups", order: "created_at", limit: 60 });
  const signals = useRows<Signal>({ table: "signals", order: "created_at", limit: 60 });
  const bias = useRows<Bias>({ table: "bias_reports", select: "instrument,allowed,target,invalidation,report_date", eq: ["report_date", todayIst()] });
  const xau = useMarket("XAUUSD");
  const btc = useMarket("BTCUSDT.P");
  const derivs = useDerivs();
  const [f, setF] = useState({ instrument: "XAUUSD", side: "long", timeframe: "15M", kind: "demand", top: "", bottom: "", fresh: true, liq: false, bos: true, note: "" });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const biasFor = (i: string) => (bias.rows ?? []).find((b) => b.instrument === i) ?? null;
  const sideFor = (i: string): "long" | "short" => biasFor(i)?.allowed ?? "long";
  const manualFor = (i: string) => (zones.rows ?? []).filter((z) => z.instrument === i && z.side === sideFor(i) && !["invalid", "done"].includes(z.status)).map((z) => ({ kind: "manual" as const, side: z.side, top: Number(z.top), bottom: Number(z.bottom), t: +new Date(z.created_at), label: `${z.timeframe} ${z.kind.replace("_", " ")}`, fresh: z.fresh, liquidityStory: z.liquidity_story, createdBos: z.created_bos }));
  const ax = useMemo(() => (xau.data ? analyze(sideFor("XAUUSD"), xau.data.htf, xau.data.poi, xau.data.ltf, manualFor("XAUUSD"), "XAUUSD") : null), [xau.data, zones.rows, bias.rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const ab = useMemo(() => (btc.data ? analyze(sideFor("BTCUSDT.P"), btc.data.htf, btc.data.poi, btc.data.ltf, manualFor("BTCUSDT.P"), "BTCUSDT.P") : null), [btc.data, zones.rows, bias.rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = [{ i: "XAUUSD", a: ax }, { i: "BTCUSDT.P", a: ab }];

  const today = (signals.rows ?? []).filter((s) => istDay(s.created_at) === todayIst());
  const armed = today.filter((s) => s.state === "ARMED" && (s.grade === "A+" || s.grade === "A"));
  const invalid = today.filter((s) => s.grade === "NO_TRADE");
  const planned = (zones.rows ?? []).filter((z) => z.status === "watching");
  const logged = today.filter((s) => s.grade === "A" || s.grade === "NO_TRADE" || s.state === "PLANNED");

  const cols = [
    { k: "Planned", n: planned.length, body: planned.map((z) => <KCard key={z.id} inst={z.instrument} side={z.side}><span className="muted" style={{ fontSize: 12 }}>{z.timeframe} {z.kind.replace("_", " ")} {num(Number(z.bottom), 2)}–{num(Number(z.top), 2)}{z.fresh ? " · fresh" : ""}</span><span className="mono faint" style={{ fontSize: 11 }}>{z.alert_set ? "Alert armed" : "No alert"}{z.note ? ` · ${z.note}` : ""}</span></KCard>) },
    { k: "In POI", n: live.filter((x) => stage(x.a) === 1).length, body: live.filter((x) => stage(x.a) === 1).map((x) => <KCard key={x.i} inst={x.i} side={sideFor(x.i)}><span className="muted" style={{ fontSize: 12 }}>{x.a!.inside!.label} {num(x.a!.inside!.bottom, 2)}–{num(x.a!.inside!.top, 2)}</span><div className="col" style={{ gap: 4 }}><span className="lbl">Waiting for</span><Chip tone="warn">Liquidity sweep</Chip></div></KCard>) },
    { k: "Swept", n: live.filter((x) => stage(x.a) === 2).length, tone: "warn" as const, body: live.filter((x) => stage(x.a) === 2).map((x) => <KCard key={x.i} inst={x.i} side={sideFor(x.i)}><span className="muted" style={{ fontSize: 12 }}>{x.a!.sweep!.label} {num(x.a!.sweep!.level, 2)} swept{x.a!.inside ? ` inside ${x.a!.inside.label}` : ""}</span><div className="col" style={{ gap: 4 }}><span className="lbl">Waiting for</span><Chip tone="warn">5M body close {sideFor(x.i) === "long" ? ">" : "<"} {num((sideFor(x.i) === "long" ? x.a!.lastLH : x.a!.lastHL) ?? 0, 2)}</Chip></div><div className="rail"><span className="done" /><span className="done" /><span className="done" /><span className="now" /><span /><span /></div></KCard>) },
    { k: "Shifted / Armed", n: armed.length + live.filter((x) => stage(x.a) === 3).length, tone: "up" as const, body: [
      ...armed.map((s) => <KCard key={s.id} inst={s.instrument} accent><div className="between"><span className="muted" style={{ fontSize: 12 }}>Model {s.model} · limit {num(Number(s.entry), 2)} · SL {num(Number(s.stop), 2)} · TP {num(Number(s.target), 2)}</span></div><span className="mono acc" style={{ fontSize: 12 }}>{s.rr ? `${num(Number(s.rr), 2)}R` : ""} · {s.grade}</span><Link className="btn pri sm" href={`/copy?s=${s.id}`}>Open in copy engine</Link></KCard>),
      ...live.filter((x) => stage(x.a) === 3 && !armed.some((s) => s.instrument === x.i)).map((x) => <KCard key={x.i} inst={x.i} side={sideFor(x.i)}><span className="muted" style={{ fontSize: 12 }}>Shift through {num(x.a!.shift!.level, 2)}{x.a!.suggest ? ` · plan ${num(x.a!.suggest.entry, 2)} / ${num(x.a!.suggest.stop, 2)} / ${num(x.a!.suggest.target, 2)}` : ""}</span><Link className="btn pri sm" href="/copilot">Open in copilot</Link></KCard>),
    ] },
    { k: "Invalid today", n: invalid.length, body: invalid.map((s) => <KCard key={s.id} inst={s.instrument}><span className="muted" style={{ fontSize: 12 }}>{(s.gate ?? []).find((b) => b.status === "fail")?.reason ?? "Gate failed"}</span><Chip tone="down">Box {(s.gate ?? []).find((b) => b.status === "fail")?.n ?? "—"} failed</Chip></KCard>) },
  ];

  const ideas = (zones.rows ?? []).filter((z) => z.status === "watching" || z.status === "tapped").map((z) => {
    const b = biasFor(z.instrument);
    const entry = z.side === "long" ? Number(z.top) : Number(z.bottom), stop = z.side === "long" ? Number(z.bottom) : Number(z.top);
    let rr: number | null = null;
    try { if (b?.target) rr = rewardToRisk(entry, stop, Number(b.target)); } catch { rr = null; }
    const blocked = b?.allowed && b.allowed !== z.side;
    return { z, b, rr, blocked };
  });

  // engine footprints
  const foot: { t: string; d: string; tone: "up" | "down" | "warn" | "" }[] = [];
  for (const [i, m] of [["XAUUSD", xau.data], ["BTCUSDT.P", btc.data]] as const) {
    if (!m) continue;
    const fv = fairValueGaps(m.ltf).filter((g) => g.filledAt === null).slice(-1)[0];
    if (fv) foot.push({ t: `Displacement + FVG · ${i} 5M`, d: `3-candle gap ${num(fv.bottom, 2)}–${num(fv.top, 2)}`, tone: fv.direction === "up" ? "up" : "down" });
    const tol = atr(m.htf, 14) * 0.1;
    for (const e of equalLevels(pivots(m.htf, 3, 3), tol).slice(-2)) foot.push({ t: `${e.kind === "EQH" ? "Equal highs" : "Equal lows"} · ${i} ${i === "XAUUSD" ? "1H" : "4H"}`, d: `${num(e.level, 2)} tested twice · tolerance 0.1 ATR`, tone: "warn" });
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const top = toNum(f.top), bottom = toNum(f.bottom);
    if (!(top > bottom)) return setError("Top must be above bottom");
    const { error } = await supabase.from("setups").insert({ instrument: f.instrument, side: f.side, timeframe: f.timeframe, kind: f.kind, top, bottom, fresh: f.fresh, liquidity_story: f.liq, created_bos: f.bos, note: f.note || null });
    if (error) return setError(error.message);
    setError(null); setOpen(false); setF({ ...f, top: "", bottom: "", note: "" }); zones.reload();
  };
  const setStatus = async (id: string, status: string) => { await supabase.from("setups").update({ status }).eq("id", id); zones.reload(); };

  const gx = xau.data;
  const asia = gx ? sessionRange(gx.poi, ASIA_Q, Date.now() - 8 * 3_600_000) : null;

  return (
    <>
      <ErrorNote error={error || zones.error || xau.error || btc.error} />
      <section className="card">
        <div className="ch"><h3>Setup formation · live</h3><span className="sp" /><button className="btn sm pri" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Add POI"}</button></div>
        {open && (
          <form onSubmit={add} className="auto-s" style={{ marginBottom: 14 }}>
            <label className="fld"><span>Instrument</span><div className="inp"><select value={f.instrument} onChange={(e) => setF({ ...f, instrument: e.target.value })}>{[...INSTS, "GOLDM", "GOLD"].map((i) => <option key={i}>{i}</option>)}</select></div></label>
            <label className="fld"><span>Side</span><div className="inp"><select value={f.side} onChange={(e) => setF({ ...f, side: e.target.value })}><option value="long">Long</option><option value="short">Short</option></select></div></label>
            <label className="fld"><span>Timeframe</span><div className="inp"><select value={f.timeframe} onChange={(e) => setF({ ...f, timeframe: e.target.value })}>{["15M", "1H", "4H", "5M"].map((t) => <option key={t}>{t}</option>)}</select></div></label>
            <label className="fld"><span>Kind</span><div className="inp"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</select></div></label>
            <Field label="Top"><input inputMode="decimal" value={f.top} onChange={(e) => setF({ ...f, top: e.target.value })} /></Field>
            <Field label="Bottom"><input inputMode="decimal" value={f.bottom} onChange={(e) => setF({ ...f, bottom: e.target.value })} /></Field>
            <Field label="Note" txt><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
            <div className="row" style={{ alignSelf: "end" }}>
              <button type="button" className={`chip ${f.fresh ? "up" : ""}`} onClick={() => setF({ ...f, fresh: !f.fresh })}>Fresh</button>
              <button type="button" className={`chip ${f.liq ? "up" : ""}`} onClick={() => setF({ ...f, liq: !f.liq })}>Liquidity story</button>
              <button type="button" className={`chip ${f.bos ? "up" : ""}`} onClick={() => setF({ ...f, bos: !f.bos })}>Broke structure</button>
              <button className="btn sm pri">Save</button>
            </div>
          </form>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(220px, 1fr))", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
          {cols.map((c) => (
            <div key={c.k} style={{ background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 16, padding: 10, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
              <div className="between"><span className="lbl-u">{c.k}</span><Chip tone={c.n ? c.tone ?? "" : ""}>{c.n}</Chip></div>
              {c.body.length ? c.body : <span className="faint" style={{ fontSize: 12, padding: 8 }}>—</span>}
            </div>
          ))}
        </div>
      </section>

      <section className="g12">
        <Card span={7} title="Trade ideas from today's plan" right={<Link className="btn ghost sm" href="/bias">Bias report</Link>}>
          {ideas.length === 0 ? <Empty>Add POIs and write today&apos;s bias</Empty> : (
            <Table head={["Instrument", "Idea", "Trigger", "Invalidation", "Est. R:R", ""]} right={[4]}>
              {ideas.map(({ z, b, rr, blocked }) => (
                <tr key={z.id}>
                  <td><b>{z.instrument}</b></td>
                  <td className={blocked ? "faint" : ""}>{z.side === "long" ? "Long" : "Short"} from {z.timeframe} {z.kind.replace("_", " ")}{b?.target ? ` to ${num(Number(b.target), 2)}` : ""}</td>
                  <td className="muted">{blocked ? `Blocked · bias is ${b!.allowed}` : "Sweep + 5M shift"}</td>
                  <td className="mono">{b?.invalidation ? num(Number(b.invalidation), 2) : "—"}</td>
                  <td className={`r mono ${rr !== null && rr >= 3 ? "acc" : ""}`}>{rr !== null ? `${num(rr, 2)}${rr < 3 ? " · skip" : ""}` : "—"}</td>
                  <td className="r"><button className="btn ghost sm" onClick={() => setStatus(z.id, "invalid")}>Invalidate</button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card span={5} title="Logged, not traded" right={<span className="faint" style={{ fontSize: 12 }}>Kept apart from A+ stats</span>}>
          {logged.length === 0 ? <Empty>Nothing logged today</Empty> : (
            <div className="col" style={{ gap: 10 }}>
              {logged.map((s) => (
                <div key={s.id} className="between">
                  <div className="col" style={{ gap: 2 }}><b style={{ fontSize: 12.5 }}>{s.grade === "A" ? "A grade" : s.grade === "NO_TRADE" ? "No trade" : "Planned"} · {s.instrument} {s.side}</b><span className="faint" style={{ fontSize: 11.5 }}>Model {s.model} · {timeShort(+new Date(s.created_at), "Asia/Kolkata")} IST{s.rr ? ` · ${num(Number(s.rr), 2)}R` : ""}</span></div>
                  <Chip tone={s.grade === "A" ? "" : s.grade === "NO_TRADE" ? "down" : "info"}>{s.grade === "A" ? "Log only" : s.grade === "NO_TRADE" ? "Rejected" : "Watching"}</Chip>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      <section className="g12">
        <Card span={4} title="BTC · derivatives" right={<Chip>Binance · mark</Chip>}>
          {!derivs.d ? <Empty>{derivs.err ? "Binance data unavailable" : "Loading…"}</Empty> : (
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              <div><div className="lbl">Funding (8h)</div><div className="kv sm">{derivs.d.funding >= 0 ? "+" : ""}{(derivs.d.funding * 100).toFixed(4)}%</div><div className="faint" style={{ fontSize: 11 }}>{derivs.d.funding >= 0 ? "Longs pay" : "Shorts pay"} · next {timeShort(derivs.d.nextFunding, "Asia/Kolkata")} IST</div></div>
              <div><div className="lbl">Open interest 24h</div><div className={`kv sm ${derivs.d.oiChange !== null && derivs.d.oiChange >= 0 ? "up" : "down"}`}>{derivs.d.oiChange !== null ? `${derivs.d.oiChange >= 0 ? "+" : ""}${pct(derivs.d.oiChange, 1)}` : "—"}</div><div className="faint" style={{ fontSize: 11 }}>{derivs.d.oiChange !== null && derivs.d.oiChange > 0 ? "New money entering" : "Positions closing"}</div></div>
              <div><div className="lbl">Mark − last</div><div className="kv sm">{num(derivs.d.mark - derivs.d.last, 1)}</div><div className="faint" style={{ fontSize: 11 }}>Stops use mark</div></div>
              <div><div className="lbl">Long/short ratio</div><div className="kv sm">{derivs.d.lsr !== null ? num(derivs.d.lsr, 2) : "—"}</div><div className="faint" style={{ fontSize: 11 }}>Top accounts</div></div>
            </div>
          )}
          {ab && (
            <>
              <div className="lbl-u" style={{ margin: "14px 0 8px" }}>Liquidity pools</div>
              <div className="col" style={{ gap: 6 }}>
                {[ab.pdh !== null && { l: "PDH", v: ab.pdh }, ab.pdl !== null && { l: "PDL", v: ab.pdl }, ab.range && { l: "Range high", v: ab.range.high }, ab.range && { l: "Range low", v: ab.range.low }].filter(Boolean).map((x) => {
                  const p = x as { l: string; v: number };
                  return <div key={p.l} className="between" style={{ fontSize: 12 }}><span className="mono">{num(p.v, 1)}</span><span className="faint">{p.l} · {p.v > ab.price ? "buy-side" : "sell-side"}</span></div>;
                })}
              </div>
            </>
          )}
        </Card>
        <Card span={4} title="Gold · context" right={<Chip>PAXG proxy</Chip>}>
          {!ax || !gx ? <Empty>Loading…</Empty> : (
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              <div><div className="lbl">Last</div><div className="kv sm">{num(ax.price, 2)}</div><div className="faint" style={{ fontSize: 11 }}>{ax.zone ? `${ax.zone} of 1H range` : "range forming"}</div></div>
              <div><div className="lbl">ATR 14 · 1H</div><div className="kv sm">{num(atr(gx.htf, 14), 2)}</div><div className="faint" style={{ fontSize: 11 }}>volatility</div></div>
              <div><div className="lbl">PDH / PDL</div><div className="kv sm">{ax.pdh !== null ? num(ax.pdh, 1) : "—"}</div><div className="faint mono" style={{ fontSize: 11 }}>{ax.pdl !== null ? num(ax.pdl, 1) : "—"}</div></div>
              <div><div className="lbl">Asia range</div><div className="kv sm">{asia ? num(asia.high, 1) : "—"}</div><div className="faint mono" style={{ fontSize: 11 }}>{asia ? num(asia.low, 1) : "—"}</div></div>
            </div>
          )}
          <div className="divider" style={{ margin: "14px 0" }} />
          <p className="muted" style={{ fontSize: 12.5 }}>Context only. It never changes a gate result.</p>
        </Card>
        <Card span={4} title="Patterns & institutional footprints">
          {foot.length === 0 ? <Empty>Loading…</Empty> : (
            <div className="col" style={{ gap: 10 }}>
              {foot.map((x, i) => (
                <div key={i} className="between"><div className="col" style={{ gap: 2 }}><b style={{ fontSize: 12.5 }}>{x.t}</b><span className="faint" style={{ fontSize: 11.5 }}>{x.d}</span></div><Chip tone={x.tone}>{x.tone === "up" ? "Bullish" : x.tone === "down" ? "Bearish" : "Liquidity"}</Chip></div>
              ))}
            </div>
          )}
        </Card>
      </section>
    </>
  );
}
