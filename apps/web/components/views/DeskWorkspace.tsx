"use client";

import { useEffect, useMemo, useState } from "react";

import {
  DESKS, EDGE_RULES, ENTRY_MODELS, INSTRUMENTS, MODEL_IDS, TF_MS, WINDOWS_BY_ID, evaluateGate, guardrails, isFxWeekend, isInWindow,
  shiftText, stateFromSetup, tradeWindows, type DeskId, type LiveDeskId, type SessionWindow, type GateInput, type InstrumentId, type ModelId,
} from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import { useMarket } from "@/lib/useMarket";
import { useLive } from "@/lib/useLive";
import { useApi } from "@/lib/useApi";
import { confluence } from "@/lib/confluence";
import { staffPost } from "@/lib/market";
import { analyze, type Zone } from "@/lib/analyze";
import { istDay, todayIst } from "@/lib/derive";
import type { Derivs } from "@/lib/server/derivs";
import type { Macro } from "@/lib/server/macro";
import type { CalEvent, Headline } from "@/lib/server/news";
import type { Investor, NewsEvent, SetupZone, Trade, TradingAccount } from "@/lib/types";
import { num, timeShort, toNum } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote, GateRow, Note, Seg, StateRail } from "@/components/ui";
import DeskChart, { OVERLAYS, type Overlay } from "@/components/desk/DeskChart";
import Ticket from "@/components/desk/Ticket";
import Analyst from "@/components/desk/Analyst";
import DeltaVenue from "@/components/desk/DeltaVenue";
import LivePnl from "@/components/LivePnl";
import { CalendarCard, DerivsCard, MacroCard, NewsCard, SessionsPanel } from "@/components/desk/Context";

type Tri = "auto" | "yes" | "no";
type Bias = { instrument: string; allowed: "long" | "short" | null; created_at: string; report_date: string; invalidation: number | null };
const triVal = (t: Tri, auto: boolean | null) => (t === "auto" ? auto : t === "yes");
const nextTri = (t: Tri): Tri => (t === "auto" ? "yes" : t === "yes" ? "no" : "auto");

function TriChip({ label, value, auto, onChange }: { label: string; value: Tri; auto: boolean | null; onChange: (t: Tri) => void }) {
  const v = triVal(value, auto);
  return (
    <button type="button" className={`chip ${v ? "up" : v === false ? "down" : ""}`} onClick={() => onChange(nextTri(value))} title="Override: engine → yes → no">
      {label}: {v === null ? "—" : v ? "yes" : "no"}{value === "auto" ? "" : " · you"}
    </button>
  );
}

/** The analysis and ticket workspace for one desk; the Arena's Trade tab hosts it. */
export default function DeskWorkspace({ deskId, inst }: { deskId: DeskId; inst: InstrumentId }) {
  // Gold and BTC have derivatives, macro, headlines and the analyst; the forex and index desks run on price and the calendar.
  const ctxDesk: LiveDeskId | null = deskId === "gold" || deskId === "btc" ? deskId : null;
  const desk = DESKS[deskId];
  const me = useMe();
  const def = INSTRUMENTS[inst];

  const [side, setSide] = useState<"long" | "short" | null>(null);
  const [model, setModel] = useState<ModelId>("A");
  const [chartTf, setChartTf] = useState<"ltf" | "poi" | "htf">("ltf");
  const [show, setShow] = useState<Record<Overlay, boolean>>({ sessions: true, pd: true, pois: true, liq: true, struct: true, pos: true });
  const [ov, setOv] = useState({ inside: "auto" as Tri, swept: "auto" as Tri, shifted: "auto" as Tri });
  const [targetReal, setTargetReal] = useState(true);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [concern, setConcern] = useState("");
  const [planForm, setPlanForm] = useState({ entry: "", stop: "", target: "" });
  const [done, setDone] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [newsAi, setNewsAi] = useState<{ overall?: string; score?: number; summary?: string; items?: { i: number; tone: string; why: string }[] } | null>(null);
  const [newsBusy, setNewsBusy] = useState(false);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  useEffect(() => { setSide(null); setPlanForm({ entry: "", stop: "", target: "" }); setChecks({}); setOv({ inside: "auto", swept: "auto", shifted: "auto" }); setModel("A"); setNewsAi(null); }, [inst]);

  const market = useMarket(inst);
  const live = useLive(inst);
  const derivs = useApi<Derivs>(ctxDesk ? `/api/market/derivs?symbol=${ctxDesk === "btc" ? "BTCUSDT" : "XAUUSDT"}` : null, 60_000);
  const macro = useApi<Macro>(ctxDesk ? `/api/market/macro?desk=${ctxDesk}` : null, 300_000);
  const news = useApi<{ items: Headline[]; errors: string[] }>(ctxDesk ? `/api/news?desk=${ctxDesk}` : null, 300_000);
  const cal = useApi<{ items: CalEvent[] }>("/api/calendar", 1_800_000);
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const investors = useRows<Investor>({ table: "investors", select: "id,name", order: "name", ascending: true });
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 300 });
  const manualNews = useRows<NewsEvent>({ table: "news_events", order: "at", limit: 50 });
  const zones = useRows<SetupZone>({ table: "setups", eq: ["instrument", inst], order: "created_at", limit: 20 });
  const bias = useRows<Bias>({ table: "bias_reports", select: "instrument,allowed,created_at,report_date,invalidation", eq: ["instrument", inst], order: "report_date", limit: 1 });

  const todayBias = (bias.rows ?? []).find((b) => b.report_date === todayIst()) ?? null;
  const htfGuess = useMemo(() => {
    if (!market.data) return null;
    const a = analyze("long", market.data.htf, market.data.poi, market.data.ltf, [], inst);
    return a.htfTrend === "down" ? "short" : a.htfTrend === "up" ? "long" : null;
  }, [market.data, inst]);
  const tradeSide: "long" | "short" = side ?? todayBias?.allowed ?? htfGuess ?? "long";
  const manual: Zone[] = (zones.rows ?? []).filter((z) => z.side === tradeSide && z.status !== "invalid" && z.status !== "done").map((z) => ({
    kind: "manual", side: z.side, top: Number(z.top), bottom: Number(z.bottom), t: +new Date(z.created_at), label: `${z.timeframe} ${z.kind.replace("_", " ")}`, fresh: z.fresh, liquidityStory: z.liquidity_story, createdBos: z.created_bos,
  }));
  const a = useMemo(() => (market.data ? analyze(tradeSide, market.data.htf, market.data.poi, market.data.ltf, manual, inst) : null), [market.data, tradeSide, inst, zones.rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // timing: window, FX weekend, news (live calendar + manually added events)
  const blockMin = me.settings?.news_block_minutes ?? 15;
  const windows = useMemo(() => tradeWindows(inst).map((w) => WINDOWS_BY_ID.get(w)).filter((w): w is SessionWindow => !!w), [inst]);
  const liveWindow = windows.find((w) => isInWindow(now, w)) ?? null;
  const closed = def.fxHours && isFxWeekend(now);
  const events: CalEvent[] = useMemo(() => [
    ...(cal.data?.items ?? []),
    ...(manualNews.rows ?? []).filter((n) => n.instruments.includes(inst)).map((n) => ({ id: n.id, at: +new Date(n.at), currency: n.currency, title: n.title, impact: n.impact, forecast: n.forecast, previous: n.previous, desks: [deskId] })),
  ].sort((x, y) => x.at - y.at), [cal.data, manualNews.rows, inst, deskId]);
  const highs = events.filter((e) => e.desks.includes(deskId) && (e.impact === "high" || (e.impact === "medium" && deskId === "gold" && me.settings?.news_medium_gold)));
  const newsClear = !highs.some((e) => Math.abs(e.at - now) <= blockMin * 60_000);
  const lastRelease = highs.map((e) => e.at).filter((t) => t <= now && now - t < 3 * 3_600_000).sort((x, y) => y - x)[0];

  // caps on own master account(s)
  const master = (accounts.rows ?? []).find((x) => x.type === "master" && x.active) ?? null;
  const masterToday = (trades.rows ?? []).filter((t) => master && t.account_id === master.id && istDay(t.opened_at) === todayIst());
  const g = master ? guardrails({ dayStartBalance: Number(master.balance) - masterToday.reduce((s, t) => s + Number(t.pnl ?? 0), 0), equity: Number(master.equity), peakEquity: Math.max(Number(master.hwm ?? 0), Number(master.equity)), tradesToday: masterToday.filter((t) => t.instrument === inst).length, lossesToday: masterToday.filter((t) => Number(t.realized_r) < 0).length }) : null;

  const entry = toNum(planForm.entry || String(a?.suggest?.entry ?? "")), stop = toNum(planForm.stop || String(a?.suggest?.stop ?? "")), target = toNum(planForm.target || String(a?.suggest?.target ?? ""));
  const hasPlan = [entry, stop, target].every((x) => Number.isFinite(x) && x > 0) && entry !== stop;
  const plan = hasPlan ? { entry, stop, target } : null;

  const gate = useMemo(() => {
    if (!a || !a.range) return null;
    const input: GateInput = {
      htfTrend: a.htfTrend, poiTfTrend: a.poiTrend, side: tradeSide, price: a.price, range: a.range,
      poi: { inside: triVal(ov.inside, !!a.inside), fresh: a.inside?.fresh ?? true, trendAligned: true, liquidityStory: a.inside?.liquidityStory ?? false, createdBos: a.inside?.createdBos ?? true },
      swept: triVal(ov.swept, !!a.sweep), shifted: triVal(ov.shifted, !!a.shift?.t || !!a.ltfShift), shiftDetail: shiftText(a),
      timing: { inWindow: !!liveWindow && !closed, newsClear, windowId: liveWindow?.id ?? null, minutesSinceNews: lastRelease ? (now - lastRelease) / 60000 : null },
      plan: plan ? { ...plan, targetIsStructural: targetReal, stopIsStructural: true } : undefined,
      minStopPct: def.minStopPct, qualityConcern: concern.trim() || null, model, instrument: inst === "XAUUSDT.P" ? "XAUUSD" : inst, modelChecks: checks,
      conditions: { capReached: g && !g.canTrade ? g.reasons[0] : null, ranAway: !planForm.entry && (a.after?.ranAway ?? false) },
      config: { aggressiveEntryAllowed: me.settings?.aggressive_entry_allowed, counterTrendAllowed: me.settings?.counter_trend_allowed, advancedModelsAllowed: me.settings?.advanced_models_allowed },
    };
    try { return evaluateGate(input); } catch { return null; }
  }, [a, tradeSide, ov, liveWindow, closed, newsClear, lastRelease, now, plan?.entry, plan?.stop, plan?.target, targetReal, def.minStopPct, concern, model, inst, checks, g?.canTrade, me.settings, planForm.entry]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = gate?.verdict === "GO";
  const state = a ? stateFromSetup(a, go, !!todayBias) : "IDLE";

  // context & confluence
  const d = derivs.data, m = macro.data;
  const conf: ReturnType<typeof confluence> = ctxDesk ? confluence(ctxDesk, tradeSide, d, m) : { score: 0, factors: [], caution: [] };

  const notes: { t: number; title: string; body: string }[] = [];
  if (gate && a) {
    if (go) notes.push({ t: now, title: "All 7 boxes pass. Verdict GO.", body: plan ? `Model ${model} limit ${num(plan.entry, def.digits)}, stop ${num(plan.stop, def.digits)}, target ${num(plan.target, def.digits)}${a.suggest && !planForm.target ? ` (${a.suggest.targetLabel})` : ""} = ${num(gate.rr ?? 0, 2)}R.` : "" });
    else if (gate.verdict === "NO") notes.push({ t: now, title: "No trade.", body: [...gate.blockers, ...gate.boxes.filter((b) => b.status === "fail").map((b) => `${b.label}: ${b.reason}`)].join(" · ") });
    else notes.push({ t: now, title: gate.grade === "A" ? "Grade A — base risk or skip." : "Waiting.", body: gate.grade === "A" ? gate.softMisses.join(" · ") : gate.waitingFor.join(" · ") });
    if (a.shift?.t) notes.push({ t: a.shift.t, title: "Market shift.", body: `5M body close ${num(a.shift.close ?? 0, def.digits)} ${tradeSide === "long" ? "above last LH" : "below last HL"} ${num(a.shift.level, def.digits)}.` });
    if (a.sweep) notes.push({ t: a.sweep.t, title: "Sweep.", body: `Wick ${num(a.sweep.wick, def.digits)} through ${a.sweep.label} ${num(a.sweep.level, def.digits)}, closed back.` });
    if (a.inside) notes.push({ t: a.inside.t, title: "In POI.", body: `${a.inside.label} ${num(a.inside.bottom, def.digits)}–${num(a.inside.top, def.digits)}${a.inside.liquidityStory ? " · swept liquidity when it formed" : ""}.` });
  }
  const timeline = [
    { n: "PLANNED", d: todayBias ? `Bias ${todayBias.allowed ?? "stand aside"}${todayBias.invalidation ? ` · wrong beyond ${num(Number(todayBias.invalidation), def.digits)}` : ""}` : a?.zones.length ? `${a.zones.length} POIs from structure (no bias written)` : "No plan", t: todayBias ? +new Date(todayBias.created_at) : null, on: !!todayBias || !!a?.zones.length },
    { n: "IN_POI", d: a?.inside ? `${a.inside.label} ${num(a.inside.bottom, def.digits)}–${num(a.inside.top, def.digits)}` : "Not in a POI", t: null, on: !!a?.inside },
    { n: "SWEPT", d: a?.sweep ? `${a.sweep.label} ${num(a.sweep.level, def.digits)}` : "Waiting", t: a?.sweep?.t ?? null, on: !!a?.sweep },
    { n: "SHIFTED", d: a?.shift?.t ? `Close through ${num(a.shift.level, def.digits)}` : "Waiting", t: a?.shift?.t ?? null, on: !!a?.shift?.t },
    { n: "ARMED", d: go ? "Gate GO" : a?.after?.ranAway ? "Ran away — no chase" : "—", t: go ? now : null, on: go },
  ];
  const chartCandles = market.data ? (chartTf === "ltf" ? market.data.ltf : chartTf === "poi" ? market.data.poi : market.data.htf) : [];
  const chartTfMs = TF_MS[chartTf === "ltf" ? def.ltf : chartTf === "poi" ? def.poi : def.htf];
  const price = live.last ?? market.data?.forming?.c ?? a?.price ?? null;
  const spread = live.bid !== null && live.ask !== null ? live.ask - live.bid : null;
  const dayOpen = market.data?.poi.find((c) => istDay(c.t) === todayIst())?.o ?? null;
  const dayChg = price !== null && dayOpen ? ((price - dayOpen) / dayOpen) * 100 : null;

  const readNews = async () => {
    if (!news.data?.items.length) return;
    setNewsBusy(true);
    try { setNewsAi(await staffPost("/api/ai", { task: "news", desk: ctxDesk ?? deskId, context: news.data.items.slice(0, 25).map((h, i) => ({ i, title: h.title, source: h.source, at: new Date(h.at).toISOString() })) })); }
    catch (e) { setNewsAi({ summary: (e as Error).message }); }
    setNewsBusy(false);
  };

  const aiContext = a && {
    instrument: inst, side: tradeSide, price, state, bias: todayBias?.allowed ?? null,
    analysis: { ...a, zones: a.zones.slice(0, 4), liquidity: a.liquidity.slice(0, 8) }, gate, plan, window: liveWindow?.name ?? null, newsClear,
    nextEvents: highs.filter((e) => e.at > now).slice(0, 4).map((e) => ({ title: e.title, at: new Date(e.at).toISOString() })),
    derivs: d && { funding: d.funding.last, fundingState: d.funding.state, basisPct: d.basisPct, oiWindows: d.oi.windows, topLs: d.ls.top.at(-1)?.ratio },
    macro: m && m.series.map((s) => ({ asset: s.label, last: s.last, chg24h: s.chg24h, chgBp24h: s.chgBp24h, trend: s.trend, corr30d: s.corr30d })),
    cot: m?.cot ?? null, realYield: m?.realYield ?? null, confluence: conf,
  };

  return (
    <>
      <ErrorNote error={market.error || accounts.error} />
      {done && <Note tone="up">{done}</Note>}
      {market.data?.approx && <Note tone="warn">Engine price source: {market.data.source}. {market.data.note ?? ""}</Note>}

      <section className="card" style={{ padding: 12 }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="col" style={{ gap: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="kv" style={{ fontSize: 24 }}>{price !== null ? num(price, def.digits) : "—"}</span>
              {dayChg !== null && <span className={`mono ${dayChg >= 0 ? "up" : "down"}`} style={{ fontSize: 13 }}>{dayChg >= 0 ? "+" : ""}{dayChg.toFixed(2)}%</span>}
              <span className={`dot ${live.connected ? "up" : "down"}`} title={live.connected ? "Live" : "Disconnected"} />
            </div>
            <span className="faint mono" style={{ fontSize: 11 }}>
              {live.source || "connecting…"}{spread !== null ? ` · spread ${num(spread, def.digits)}` : ""}{live.mark !== null && def.kind === "perp" ? ` · mark ${num(live.mark, def.digits)}` : ""}
            </span>
          </div>
          <span style={{ flex: 1 }} />
          <div className="col" style={{ gap: 2, alignItems: "flex-end" }}>
            <div className="row" style={{ gap: 6 }}>
              <Chip tone={go ? "solid" : gate?.verdict === "NO" ? "down" : "warn"}>{state}{gate ? ` · ${gate.grade.replace("_", " ")}` : ""}</Chip>
              {ctxDesk && <Chip tone={conf.score > 20 ? "up" : conf.score < -20 ? "down" : ""}>Context {conf.score > 0 ? "+" : ""}{conf.score}</Chip>}
              {closed ? <Chip tone="warn">Market closed (weekend)</Chip> : liveWindow ? <Chip tone="up" dot>{liveWindow.name} live</Chip> : <Chip>Outside windows</Chip>}
              {!newsClear && <Chip tone="down" dot>News block</Chip>}
            </div>
            <span className="faint" style={{ fontSize: 11 }}>{def.priceBasis} · {INSTRUMENTS[inst].htf.toUpperCase()} · {def.poi.toUpperCase()} · {def.ltf.toUpperCase()}</span>
          </div>
        </div>
      </section>

      <div className="g12">
        <section className="s8 col" style={{ gap: 16 }}>
          <div className="card flush">
            <div className="row" style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>
              <Seg label="Timeframe" value={chartTf} onChange={setChartTf} options={[{ v: "ltf", l: def.ltf.toUpperCase() }, { v: "poi", l: def.poi.toUpperCase() }, { v: "htf", l: def.htf.toUpperCase() }]} />
              <span style={{ flex: 1 }} />
              {OVERLAYS.map((o) => (
                <button key={o.id} type="button" className={`chip ${show[o.id] ? "acc" : ""}`} aria-pressed={show[o.id]} onClick={() => setShow({ ...show, [o.id]: !show[o.id] })}>{o.l}</button>
              ))}
            </div>
            {market.data ? <DeskChart candles={chartCandles} forming={chartTf === "ltf" ? market.data.forming : null} tfMs={chartTfMs} live={price} analysis={a} show={show} plan={plan} side={tradeSide} digits={def.digits} markersOn={chartTf === "ltf"} windows={windows} /> : <div style={{ height: 520, display: "grid", placeItems: "center" }} className="faint">Loading candles…</div>}
            <div className="between" style={{ padding: "8px 12px", borderTop: "1px solid var(--line)" }}>
              <span className="faint" style={{ fontSize: 11 }}>{`Engine overlays on closed candles · ${market.data?.source ?? "…"} · forming bar from live ticks · charts by TradingView Lightweight Charts™`}</span>
              <span className="faint mono" style={{ fontSize: 11 }}>{a?.range ? `range ${num(a.range.low, def.digits)} – ${num(a.range.high, def.digits)} · ${a.zone ?? ""} ${a.pos !== null ? `${a.pos.toFixed(0)}%` : ""}` : ""}</span>
            </div>
          </div>

          <div className="g12">
            <Card span={6} title="Trade timeline" right={<Chip tone={go ? "up" : "warn"}>{state}</Chip>}>
              <StateRail state={state} />
              <div className="col" style={{ gap: 0, marginTop: 10 }}>
                {timeline.map((s) => (
                  <div key={s.n} style={{ display: "grid", gridTemplateColumns: "14px 74px minmax(0,1fr)", gap: 10, padding: "7px 0", alignItems: "start" }}>
                    <span className="dot" style={{ marginTop: 5, color: s.on ? "var(--accent)" : "var(--line-2)" }} /><b className="mono" style={{ fontSize: 11.5 }}>{s.n}</b>
                    <span className="muted" style={{ fontSize: 12 }}>{s.d} {s.t && <span className="faint mono">{timeShort(s.t, "Asia/Kolkata")}</span>}</span>
                  </div>
                ))}
              </div>
              {gate && gate.waitingFor.length > 0 && (
                <div className="col" style={{ gap: 6, marginTop: 8 }}>
                  <span className="lbl-u">Waiting for</span>
                  <div className="row" style={{ gap: 6 }}>{gate.waitingFor.map((w) => <Chip key={w} tone="warn">{w}</Chip>)}</div>
                </div>
              )}
              {g && !g.canTrade && <p className="down" style={{ fontSize: 12, marginTop: 8 }}>Guardrail: {g.reasons.join(" · ")}</p>}
            </Card>
            {ctxDesk ? <Card span={6} title="Confluence" right={<Chip tone={conf.score > 20 ? "up" : conf.score < -20 ? "down" : ""}>{tradeSide} · {conf.score > 0 ? "+" : ""}{conf.score}</Chip>}>
              {conf.factors.length === 0 ? <Empty>Loading context…</Empty> : conf.factors.map((f) => (
                <div key={f.id} className="between" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
                  <span className="col" style={{ gap: 0 }}><b style={{ fontWeight: 500 }}>{f.label}</b><span className="faint" style={{ fontSize: 11 }}>{f.detail}</span></span>
                  <Chip tone={f.stance === "supports" ? "up" : f.stance === "against" ? "down" : ""}>{f.stance}</Chip>
                </div>
              ))}
              {conf.caution.map((c) => <p key={c} className="warn" style={{ fontSize: 12, marginTop: 6 }}>Caution: {c}</p>)}
              <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Weighted read of dollar, yields, positioning and flow for a {tradeSide}. It informs size and conviction; the A+ gate alone decides GO.</p>
            </Card> : <LivePnl span={6} instrument={inst} />}
          </div>
        </section>

        <aside className="s4 col" style={{ gap: 16 }}>
          <Card title="A+ gate" right={gate ? <Chip tone={go ? "solid" : gate.verdict === "NO" ? "down" : "warn"}>{gate.boxes.filter((b) => b.status === "pass").length} / 7 · {gate.verdict}</Chip> : null}>
            {!a ? <Empty>Loading…</Empty> : !a.range ? <Empty>Not enough HTF structure yet</Empty> : gate && (
              <>
                {gate.boxes.map((b) => <GateRow key={b.n} n={b.n} label={b.label} reason={b.reason} status={b.status} />)}
                {gate.blockers.length > 0 && <div className="col" style={{ gap: 4, marginTop: 8 }}>{gate.blockers.map((x) => <Chip key={x} tone="down">{x}</Chip>)}</div>}
              </>
            )}
            <div className="divider" style={{ margin: "10px 0" }} />
            <div className="col" style={{ gap: 8 }}>
              <div className="between"><span className="lbl">Side{todayBias ? " (bias)" : htfGuess ? " (HTF)" : ""}</span><Seg label="Side" value={tradeSide} onChange={(v) => setSide(v)} options={[{ v: "long", l: "Long" }, { v: "short", l: "Short" }]} /></div>
              <div className="between">
                <span className="lbl">Model</span>
                <div className="inp" style={{ width: 190, height: 32 }}>
                  <select aria-label="Entry model" value={model} onChange={(e) => { setModel(e.target.value as ModelId); setChecks({}); }}>
                    {MODEL_IDS.map((x) => <option key={x} value={x}>{ENTRY_MODELS[x].short} · {ENTRY_MODELS[x].name}</option>)}
                  </select>
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <TriChip label="In POI" value={ov.inside} auto={a ? !!a.inside : null} onChange={(t) => setOv({ ...ov, inside: t })} />
                <TriChip label="Swept" value={ov.swept} auto={a ? !!a.sweep : null} onChange={(t) => setOv({ ...ov, swept: t })} />
                <TriChip label="Shift" value={ov.shifted} auto={a ? !!a.shift?.t : null} onChange={(t) => setOv({ ...ov, shifted: t })} />
                {ENTRY_MODELS[model].checks.map((c) => (
                  <button key={c.id} type="button" className={`chip ${checks[c.id] ? "up" : ""}`} onClick={() => setChecks({ ...checks, [c.id]: !checks[c.id] })}>{c.label}: {checks[c.id] ? "yes" : "—"}</button>
                ))}
                <button type="button" className={`chip ${targetReal ? "up" : "down"}`} onClick={() => setTargetReal(!targetReal)}>Target real: {targetReal ? "yes" : "no"}</button>
              </div>
              <div className="inp txt"><input aria-label="Quality concern" placeholder="Quality concern (drops A+ to A)" value={concern} onChange={(e) => setConcern(e.target.value)} /></div>
            </div>
          </Card>

          <Ticket def={def} side={tradeSide} plan={plan} suggest={a?.suggest ?? null} targets={a?.targets ?? []} minRR={EDGE_RULES.minRR} gate={gate} window={liveWindow?.id ?? null} accounts={accounts.rows ?? []} investors={investors.rows ?? []} onPlan={setPlanForm} onDone={(msg) => { setDone(msg); trades.reload(); }} />

          <Card title="Live tape" right={<Chip>{live.tape.length} prints</Chip>}>
            {live.tape.length === 0 ? <Empty>{live.connected ? "Waiting for trades…" : "Connecting…"}</Empty> : (
              <div className="col mono" style={{ gap: 0, maxHeight: 220, overflowY: "auto", fontSize: 11.5 }}>
                {live.tape.slice(0, 24).map((t, i) => (
                  <div key={i} className="between" style={{ padding: "2px 0" }}>
                    <span className={t.side === "buy" ? "up" : t.side === "sell" ? "down" : ""}>{num(t.price, def.digits)}</span>
                    <span className="faint">{t.qty ? num(t.qty, 4) : ""}</span>
                    <span className="faint">{new Date(t.t).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false })}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </aside>
      </div>

      {ctxDesk && <div className="g12">
        {ctxDesk === "btc"
          ? <DerivsCard span={4} d={d} error={derivs.error} liqs={inst === "BTCUSDT.P" ? live.liqs : undefined} />
          : <DerivsCard span={4} d={d} error={derivs.error} liqs={inst === "XAUUSDT.P" ? live.liqs : undefined} title="XAUUSDT.P positioning (crypto gold perp)" />}
        <MacroCard span={4} m={m} error={macro.error} desk={ctxDesk} />
        <DeltaVenue desk={ctxDesk} />
      </div>}

      <div className="g12">
        <div className="s4 col" style={{ gap: 16 }}>
          {market.data ? <SessionsPanel candles={market.data.poi} now={now} digits={def.digits} span={12} /> : <Card title="Session analysis"><Empty>Loading…</Empty></Card>}
        </div>
        <div className="s8 col" style={{ gap: 16 }}>
          <Analyst desk={deskId} context={aiContext} notes={notes} />
          {!ctxDesk && <CalendarCard events={cal.data ? events : null} error={cal.error} desk={deskId} blockMinutes={blockMin} now={now} span={12} />}
        </div>
      </div>

      {ctxDesk && <div className="g12">
        <NewsCard items={news.data?.items ?? null} error={news.error} ai={newsAi} onAi={readNews} busy={newsBusy} />
        <CalendarCard events={cal.data ? events : null} error={cal.error} desk={deskId} blockMinutes={blockMin} now={now} />
      </div>}
    </>
  );
}
