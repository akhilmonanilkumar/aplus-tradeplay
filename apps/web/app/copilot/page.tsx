"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  EDGE_WINDOWS, ENTRY_MODELS, MODEL_IDS, evaluateGate, guardrails, isInWindow, riskForGrade,
  type GateInput, type ModelId,
} from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { useMarket } from "@/lib/useMarket";
import { analyze, type Zone } from "@/lib/analyze";
import { FEED, INSTRUMENT_TF } from "@/lib/market";
import { eligible, plan as planCopy, queueOrders } from "@/lib/copy";
import { istDay, todayIst } from "@/lib/derive";
import type { NewsEvent, SetupZone, Signal, Trade, TradingAccount } from "@/lib/types";
import { money, num, timeShort, toNum } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote, GateRow, Note, Seg } from "@/components/ui";
import EdgeChart, { OVERLAYS, type Overlay } from "@/components/EdgeChart";

type Inst = "XAUUSD" | "BTCUSDT.P";
type Tri = "auto" | "yes" | "no";
type Bias = { instrument: string; allowed: "long" | "short" | null; created_at: string; report_date: string };

const triVal = (t: Tri, auto: boolean | null) => (t === "auto" ? auto : t === "yes");
const nextTri = (t: Tri): Tri => (t === "auto" ? "yes" : t === "yes" ? "no" : "auto");

function TriChip({ label, value, auto, onChange }: { label: string; value: Tri; auto: boolean | null; onChange: (t: Tri) => void }) {
  const v = triVal(value, auto);
  return (
    <button type="button" className={`chip ${v ? "up" : v === false ? "down" : ""}`} onClick={() => onChange(nextTri(value))} title="Click to override: auto → yes → no">
      {label}: {v === null ? "—" : v ? "yes" : "no"}{value === "auto" ? " · engine" : " · you"}
    </button>
  );
}

export default function Copilot() {
  const router = useRouter();
  const me = useMe();
  const [inst, setInst] = useState<Inst>("XAUUSD");
  const [side, setSide] = useState<"long" | "short" | null>(null);
  const [model, setModel] = useState<ModelId>("A");
  const [tab, setTab] = useState<"engine" | "tv">("engine");
  const [show, setShow] = useState<Record<Overlay, boolean>>({ sessions: true, pd: true, pois: true, liq: true, struct: true, pos: true });
  const [ov, setOv] = useState({ inside: "auto" as Tri, swept: "auto" as Tri, shifted: "auto" as Tri, liq: "auto" as Tri, bos: "auto" as Tri });
  const [targetReal, setTargetReal] = useState(true);
  const [stopReal, setStopReal] = useState(true);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [concern, setConcern] = useState("");
  const [form, setForm] = useState({ entry: "", stop: "", target: "", risk: "" });
  const [route, setRoute] = useState<"master" | "selected" | "all">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [answers, setAnswers] = useState<{ q: string; a: string; at: number }[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { setSide(null); setForm({ entry: "", stop: "", target: "", risk: "" }); setChecks({}); setOv({ inside: "auto", swept: "auto", shifted: "auto", liq: "auto", bos: "auto" }); }, [inst]);

  const market = useMarket(inst);
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 200 });
  const news = useRows<NewsEvent>({ table: "news_events", order: "at", limit: 50 });
  const zones = useRows<SetupZone>({ table: "setups", eq: ["instrument", inst], order: "created_at", limit: 20 });
  const bias = useRows<Bias>({ table: "bias_reports", select: "instrument,allowed,created_at,report_date", eq: ["instrument", inst], order: "report_date", limit: 1 });

  const todayBias = (bias.rows ?? []).find((b) => b.report_date === todayIst()) ?? null;
  const htfSideGuess = useMemo(() => {
    if (!market.data) return null;
    const a = analyze("long", market.data.htf, market.data.poi, market.data.ltf, [], inst);
    return a.htfTrend === "down" ? "short" : a.htfTrend === "up" ? "long" : null;
  }, [market.data, inst]);
  const tradeSide: "long" | "short" = side ?? todayBias?.allowed ?? htfSideGuess ?? "long";

  const manual: Zone[] = (zones.rows ?? []).filter((z) => z.side === tradeSide && z.status !== "invalid" && z.status !== "done").map((z) => ({
    kind: "manual", side: z.side, top: Number(z.top), bottom: Number(z.bottom), t: +new Date(z.created_at), label: `${z.timeframe} ${z.kind.replace("_", " ")}`, fresh: z.fresh, liquidityStory: z.liquidity_story, createdBos: z.created_bos,
  }));
  const a = useMemo(() => (market.data ? analyze(tradeSide, market.data.htf, market.data.poi, market.data.ltf, manual, inst) : null), [market.data, tradeSide, inst, zones.rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // timing
  const liveWindow = EDGE_WINDOWS.find((w) => isInWindow(now, w)) ?? null;
  const block = (me.settings?.news_block_minutes ?? 15) * 60_000;
  const high = (news.rows ?? []).filter((n) => n.instruments.includes(inst) && (n.impact === "high" || (n.impact === "medium" && inst === "XAUUSD" && me.settings?.news_medium_gold)));
  const newsClear = !high.some((n) => Math.abs(+new Date(n.at) - now) <= block);
  const lastRelease = high.map((n) => +new Date(n.at)).filter((t) => t <= now && now - t < 3 * 3_600_000).sort((x, y) => y - x)[0];
  // caps (master account)
  const master = (accounts.rows ?? []).find((x) => x.type === "master" && x.active) ?? null;
  const masterToday = (trades.rows ?? []).filter((t) => master && t.account_id === master.id && istDay(t.opened_at) === todayIst());
  const g = master ? guardrails({ dayStartBalance: Number(master.balance) - masterToday.reduce((s, t) => s + Number(t.pnl ?? 0), 0), equity: Number(master.equity), peakEquity: Math.max(Number(master.hwm ?? 0), Number(master.equity)), tradesToday: masterToday.length, lossesToday: masterToday.filter((t) => Number(t.realized_r) < 0).length }) : null;

  const entry = toNum(form.entry || String(a?.suggest?.entry ?? "")), stop = toNum(form.stop || String(a?.suggest?.stop ?? "")), target = toNum(form.target || String(a?.suggest?.target ?? ""));
  const hasPlan = [entry, stop, target].every((x) => Number.isFinite(x) && x > 0) && entry !== stop;
  const planObj = hasPlan ? { entry, stop, target } : null;

  const result = useMemo(() => {
    if (!a || !a.range) return null;
    const input: GateInput = {
      htfTrend: a.htfTrend, poiTfTrend: a.poiTrend, side: tradeSide, price: a.price, range: a.range,
      poi: {
        inside: triVal(ov.inside, !!a.inside),
        fresh: a.inside?.fresh ?? true,
        trendAligned: true,
        liquidityStory: !!triVal(ov.liq, a.inside?.liquidityStory ?? false),
        createdBos: !!triVal(ov.bos, a.inside?.createdBos ?? true),
      },
      swept: triVal(ov.swept, !!a.sweep),
      shifted: triVal(ov.shifted, !!a.shift?.t),
      timing: { inWindow: !!liveWindow, newsClear, windowId: liveWindow?.id ?? null, minutesSinceNews: lastRelease ? (now - lastRelease) / 60000 : null },
      plan: planObj ? { ...planObj, targetIsStructural: targetReal, stopIsStructural: stopReal } : undefined,
      minStopPct: inst === "BTCUSDT.P" ? 0.4 : undefined,
      qualityConcern: concern.trim() || null,
      model, instrument: inst, modelChecks: checks,
      conditions: { capReached: g && !g.canTrade ? g.reasons[0] : null },
      config: { aggressiveEntryAllowed: me.settings?.aggressive_entry_allowed, counterTrendAllowed: me.settings?.counter_trend_allowed, advancedModelsAllowed: me.settings?.advanced_models_allowed },
    };
    try { return evaluateGate(input); } catch (e) { return { err: (e as Error).message } as const; }
  }, [a, tradeSide, ov, liveWindow, newsClear, lastRelease, now, planObj?.entry, planObj?.stop, planObj?.target, targetReal, stopReal, inst, concern, model, checks, g?.canTrade, me.settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const gate = result && !("err" in result) ? result : null;
  const go = gate?.verdict === "GO";
  const canPlace = gate && !gate.blockers.length && (gate.grade === "A+" || gate.grade === "A") && hasPlan;
  const riskPct = toNum(form.risk) || (gate ? riskForGrade(gate.grade) : 0) || riskForGrade("A");

  const pool = eligible(accounts.rows ?? []);
  const targets = route === "master" ? pool.filter((x) => x.type === "master") : route === "selected" ? pool.filter((x) => picked.has(x.id)) : pool;
  const fan = planObj ? planCopy(targets, inst, planObj, riskPct, me.settings) : { decisions: [], error: null };

  const place = async () => {
    if (!gate || !planObj) return;
    setBusy(true); setError(null); setDone(null);
    const { data, error } = await supabase.from("signals").insert({
      instrument: inst, side: tradeSide, model, session_window: liveWindow?.id ?? null, entry: planObj.entry, stop: planObj.stop, target: planObj.target,
      rr: gate.rr, grade: gate.grade, gate: gate.boxes, state: "ARMED", edge_version: "1.1",
    }).select("id").single();
    if (error) { setBusy(false); return setError(error.message); }
    const e2 = await queueOrders({ id: data.id, side: tradeSide, ...planObj }, fan.decisions, me.settings);
    setBusy(false);
    if (e2) return setError(e2);
    setDone(`${fan.decisions.filter((d) => d.action !== "BLOCK").length} orders queued${me.settings?.mode === "PAPER" ? " (paper)" : ""}`);
    router.refresh();
  };

  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    setQ("");
    const { data } = await supabase.auth.getSession();
    const res = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: JSON.stringify({ question, context: { instrument: inst, side: tradeSide, model, analysis: a && { ...a, zones: a.zones.slice(0, 4) }, gate, plan: planObj, window: liveWindow?.name ?? null, newsClear } }) });
    const j = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
    setAnswers((x) => [{ q: question, a: j.answer ?? j.error ?? "No answer", at: Date.now() }, ...x].slice(0, 6));
  };

  // engine notes (deterministic explanation of what the engine sees)
  const notes: { t: number; title: string; body: string }[] = [];
  if (gate && a) {
    if (gate.verdict === "GO") notes.push({ t: now, title: `All 7 boxes pass. Verdict GO.`, body: planObj ? `Model ${model} limit ${num(planObj.entry, 2)}, stop ${num(planObj.stop, 2)}, target ${num(planObj.target, 2)}${a.suggest && !form.target ? ` (${a.suggest.targetLabel})` : ""} = ${num(gate.rr ?? 0, 2)}R.` : "" });
    else if (gate.verdict === "NO") notes.push({ t: now, title: "No trade.", body: [...gate.blockers, ...gate.boxes.filter((b) => b.status === "fail").map((b) => `${b.label}: ${b.reason}`)].join(" · ") });
    else notes.push({ t: now, title: gate.grade === "A" ? "Grade A — base risk or skip." : "Waiting.", body: gate.grade === "A" ? gate.softMisses.join(" · ") : gate.waitingFor.join(" · ") });
    if (a.shift?.t) notes.push({ t: a.shift.t, title: "Market shift.", body: `5M body close ${num(a.shift.close ?? 0, 2)} ${tradeSide === "long" ? "above last LH" : "below last HL"} ${num(a.shift.level, 2)}.` });
    if (a.sweep) notes.push({ t: a.sweep.t, title: "Sweep confirmed.", body: `Wick ${num(a.sweep.wick, 2)} through ${a.sweep.label} ${num(a.sweep.level, 2)}, closed back.` });
    if (a.inside) notes.push({ t: a.inside.t, title: "In POI.", body: `${a.inside.label} ${num(a.inside.bottom, 2)}–${num(a.inside.top, 2)}${a.inside.liquidityStory ? " · swept liquidity when it formed" : ""}.` });
  }
  const timeline = [
    { n: "PLANNED", d: todayBias ? `Bias ${todayBias.allowed ?? "none"}` : "No bias today", t: todayBias ? +new Date(todayBias.created_at) : null, c: todayBias ? "acc" : "faint" },
    { n: "IN_POI", d: a?.inside ? a.inside.label : "Not in a POI", t: a?.inside ? null : null, c: a?.inside ? "acc" : "faint" },
    { n: "SWEPT", d: a?.sweep ? `${a.sweep.label} ${num(a.sweep.level, 2)}` : "Waiting", t: a?.sweep?.t ?? null, c: a?.sweep ? "acc" : "faint" },
    { n: "SHIFTED", d: a?.shift?.t ? `Close through ${num(a.shift.level, 2)}` : "Waiting", t: a?.shift?.t ?? null, c: a?.shift?.t ? "acc" : "faint" },
    { n: "ARMED", d: go ? "Gate GO" : "—", t: go ? now : null, c: go ? "up" : "faint" },
  ];
  const modelChecks = ENTRY_MODELS[model].checks;

  return (
    <>
      <ErrorNote error={market.error || error || accounts.error} />
      {done && <Note tone="up">{done}</Note>}
      <div className="g12">
        <section className="s9 col" style={{ gap: 12 }}>
          <div className="row" role="group" aria-label="Chart overlays">
            <Seg label="Instrument" value={inst} onChange={setInst} options={[{ v: "XAUUSD", l: "XAUUSD" }, { v: "BTCUSDT.P", l: "BTCUSDT.P" }]} />
            {OVERLAYS.map((o) => (
              <button key={o.id} type="button" className={`chip ${show[o.id] ? "acc" : ""}`} aria-pressed={show[o.id]} onClick={() => setShow({ ...show, [o.id]: !show[o.id] })}><span className="dot" />{o.l}</button>
            ))}
            <span style={{ flex: 1 }} />
            <Chip tone="acc">Model {model} · {ENTRY_MODELS[model].name}</Chip>
          </div>

          <div className="card flush">
            <div className="between" style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>
              <Seg label="Chart" value={tab} onChange={setTab} options={[{ v: "engine", l: "Engine" }, { v: "tv", l: "TradingView" }]} />
              <span className="faint mono" style={{ fontSize: 11 }}>{INSTRUMENT_TF[inst]!.label}{a?.range ? ` · range ${num(a.range.low, 2)} – ${num(a.range.high, 2)}` : ""}</span>
            </div>
            {tab === "engine" ? (
              market.data ? <EdgeChart candles={market.data.ltf} analysis={a} show={show} plan={planObj} side={tradeSide} /> : <div style={{ height: 540, display: "grid", placeItems: "center" }} className="faint">Loading candles…</div>
            ) : (
              <iframe title={`TradingView ${FEED[inst]!.tv}`} style={{ width: "100%", height: 540, border: 0, display: "block" }}
                src={`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(FEED[inst]!.tv)}&interval=5&theme=dark&style=1&timezone=Asia%2FKolkata&hide_side_toolbar=0&withdateranges=1&saveimage=0`} />
            )}
            <div className="between" style={{ padding: "8px 12px", borderTop: "1px solid var(--line)" }}>
              <span className="faint" style={{ fontSize: 11 }}>Overlays by A+ Tradeplay engine (closed candles only) · {FEED[inst]!.source} · TradingView Lightweight Charts™</span>
              <span className="faint mono" style={{ fontSize: 11 }}>{a ? `last ${num(a.price, 2)}` : ""}</span>
            </div>
          </div>

          <div className="g12">
            <Card span={7} title="AI agent" right={<><Chip tone="acc" dot>engine</Chip><span className="faint" style={{ fontSize: 11.5 }}>Explains engine output · never decides GO</span></>}>
              {notes.length === 0 && answers.length === 0 ? <Empty>Waiting for market data</Empty> : (
                <div className="feed">
                  {answers.map((x) => (
                    <div key={x.at} className="fi"><span className="t">{timeShort(x.at, "Asia/Kolkata")}</span><div style={{ fontSize: 12.5 }}><b>{x.q}</b> <span className="muted">{x.a}</span></div></div>
                  ))}
                  {notes.sort((x, y) => y.t - x.t).map((n, i) => (
                    <div key={i} className="fi"><span className="t">{timeShort(n.t, "Asia/Kolkata")}</span><div style={{ fontSize: 12.5 }}><b>{n.title}</b> <span className="muted">{n.body}</span></div></div>
                  ))}
                </div>
              )}
              <form className="row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); ask(); }}>
                <div className="inp txt" style={{ flex: 1 }}><input aria-label="Ask the agent" placeholder="Ask why, or what would invalidate this…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
                <button className="btn sm" disabled={!q.trim()}>Ask</button>
              </form>
            </Card>
            <Card span={5} title="State timeline" right={<Chip tone={go ? "up" : "warn"}>{go ? "ARMED" : gate?.grade.replace("_", " ") ?? "IDLE"}</Chip>}>
              <div className="col" style={{ gap: 0 }}>
                {timeline.map((s) => (
                  <div key={s.n} style={{ display: "grid", gridTemplateColumns: "14px 78px minmax(0,1fr)", gap: 10, padding: "7px 0", alignItems: "start" }}>
                    <span className={`dot ${s.c}`} style={{ marginTop: 5 }} /><b className="mono" style={{ fontSize: 11.5 }}>{s.n}</b>
                    <span className="muted" style={{ fontSize: 12 }}>{s.d} {s.t && <span className="faint mono">{timeShort(s.t, "Asia/Kolkata")}</span>}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </section>

        <aside className="s3 col" style={{ gap: 12 }}>
          <Card title="A+ gate" right={gate ? <Chip tone={go ? "solid" : gate.verdict === "NO" ? "down" : "warn"}>{gate.boxes.filter((b) => b.status === "pass").length} / 7 · {gate.verdict}</Chip> : null}>
            {!a ? <Empty>Loading…</Empty> : !a.range ? <Empty>Not enough HTF structure yet</Empty> : result && "err" in result ? <p className="down" style={{ fontSize: 12.5 }}>{result.err}</p> : gate && (
              <>
                {gate.boxes.map((b) => <GateRow key={b.n} n={b.n} label={b.label} reason={b.reason} status={b.status} />)}
                {gate.blockers.length > 0 && <div className="col" style={{ gap: 4, marginTop: 8 }}>{gate.blockers.map((x) => <Chip key={x} tone="down">{x}</Chip>)}</div>}
              </>
            )}
            <div className="divider" style={{ margin: "10px 0" }} />
            <div className="col" style={{ gap: 8 }}>
              <div className="between"><span className="lbl">Side</span><Seg label="Side" value={tradeSide} onChange={(v) => setSide(v)} options={[{ v: "long", l: "Long" }, { v: "short", l: "Short" }]} /></div>
              <div className="between">
                <span className="lbl">Model</span>
                <div className="inp" style={{ width: 170, height: 32 }}>
                  <select aria-label="Entry model" value={model} onChange={(e) => { setModel(e.target.value as ModelId); setChecks({}); }}>
                    {MODEL_IDS.map((m) => <option key={m} value={m}>{m} · {ENTRY_MODELS[m].name}</option>)}
                  </select>
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <TriChip label="In POI" value={ov.inside} auto={a ? !!a.inside : null} onChange={(t) => setOv({ ...ov, inside: t })} />
                <TriChip label="Liquidity story" value={ov.liq} auto={a?.inside ? a.inside.liquidityStory : null} onChange={(t) => setOv({ ...ov, liq: t })} />
                <TriChip label="POI broke structure" value={ov.bos} auto={a?.inside ? a.inside.createdBos : null} onChange={(t) => setOv({ ...ov, bos: t })} />
                <TriChip label="Swept" value={ov.swept} auto={a ? !!a.sweep : null} onChange={(t) => setOv({ ...ov, swept: t })} />
                <TriChip label="Shift" value={ov.shifted} auto={a ? !!a.shift?.t : null} onChange={(t) => setOv({ ...ov, shifted: t })} />
                {modelChecks.map((c) => (
                  <button key={c.id} type="button" className={`chip ${checks[c.id] ? "up" : ""}`} onClick={() => setChecks({ ...checks, [c.id]: !checks[c.id] })}>{c.label}: {checks[c.id] ? "yes" : "—"}</button>
                ))}
                <button type="button" className={`chip ${targetReal ? "up" : "down"}`} onClick={() => setTargetReal(!targetReal)}>Target real: {targetReal ? "yes" : "no"}</button>
                <button type="button" className={`chip ${stopReal ? "up" : "down"}`} onClick={() => setStopReal(!stopReal)}>Stop structural: {stopReal ? "yes" : "no"}</button>
              </div>
              <div className="inp txt"><input aria-label="Quality concern" placeholder="Quality concern (drops A+ to A)" value={concern} onChange={(e) => setConcern(e.target.value)} /></div>
            </div>
          </Card>

          <Card title="Order ticket" right={<Chip>Limit · {tradeSide}</Chip>}>
            <div className="seg" role="group" aria-label="Route" style={{ width: "100%", display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
              {([["master", "Master"], ["selected", "Selected"], ["all", "All routes"]] as const).map(([v, l]) => <button key={v} type="button" className={route === v ? "on" : ""} onClick={() => setRoute(v)}>{l}</button>)}
            </div>
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 10 }}>
              {(["entry", "risk", "stop", "target"] as const).map((k) => (
                <label key={k} className="fld">
                  <span style={{ textTransform: "capitalize" }}>{k}</span>
                  <div className="inp">
                    <input inputMode="decimal" value={form[k]} placeholder={k === "risk" ? num(riskPct, 2) : a?.suggest ? num(a.suggest[k as "entry" | "stop" | "target"], 2).replace(/,/g, "") : ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                    {k === "risk" && <span className="u">%</span>}
                  </div>
                </label>
              ))}
            </div>
            {a?.suggest && (form.entry || form.stop || form.target) && <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setForm({ ...form, entry: "", stop: "", target: "" })}>Use engine plan</button>}
            <div className="lbl-u" style={{ margin: "12px 0 2px" }}>Targets · {route === "master" ? "master only" : route === "selected" ? `${picked.size} selected` : "all copy routes"}</div>
            {fan.error && <p className="down" style={{ fontSize: 12 }}>{fan.error}</p>}
            {targets.length === 0 ? <Empty>No accounts on this route</Empty> : (route === "selected" ? pool : targets).map((acc) => {
              const d = fan.decisions.find((x) => x.accountId === acc.id);
              const on = route !== "selected" || picked.has(acc.id);
              return (
                <div key={acc.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 12, opacity: on ? 1 : 0.5 }}
                  onClick={() => { if (route !== "selected") return; const n = new Set(picked); if (n.has(acc.id)) n.delete(acc.id); else n.add(acc.id); setPicked(n); }}>
                  <div className="col" style={{ gap: 1, minWidth: 0 }}><b style={{ fontWeight: 500 }}>{acc.name}</b><span className="faint mono" style={{ fontSize: 11 }}>{d ? `${money(d.riskAmount)} risk${d.reasons.length ? ` · ${d.reasons[0]}` : ""}` : acc.venue}</span></div>
                  <span className="mono">{d ? num(d.size, inst.startsWith("BTC") ? 3 : 2) : "—"}</span>
                  <Chip tone={d?.action === "SEND" ? "up" : d?.action === "BLOCK" ? "down" : d?.action === "CONFIRM" ? "acc" : ""}>{d?.action ?? acc.copy_policy}</Chip>
                </div>
              );
            })}
            <button className={`btn ${tradeSide === "long" ? "buy" : "sell"} lg block`} style={{ marginTop: 12 }} disabled={!canPlace || busy || !!me.settings?.kill_switch || fan.decisions.length === 0} onClick={place}>
              {busy ? "Placing…" : planObj ? `Place limit ${tradeSide === "long" ? "buy" : "sell"} · ${num(planObj.entry, 2)}` : "No plan yet"}
            </button>
            {gate?.grade === "A" && <p className="warn" style={{ fontSize: 11.5, marginTop: 6 }}>Grade A: base risk {num(riskForGrade("A"), 2)}% only.</p>}
          </Card>
        </aside>
      </div>
    </>
  );
}
