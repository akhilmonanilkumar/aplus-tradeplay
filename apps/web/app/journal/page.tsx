"use client";

import { useMemo, useState } from "react";
import { MODEL_IDS, ENTRY_MODELS, rewardToRisk } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { realizedR } from "@/lib/calc";
import type { Trade, TradingAccount } from "@/lib/types";
import { dateShort, money, num, toNum } from "@/lib/fmt";
import { Chip, Empty, ErrorNote, Note, Table } from "@/components/ui";

type Gate = { n: number; label: string; status: string; reason: string }[];
type T = Trade & { gate: Gate | null; sweep_type: string | null; htf_zone: string | null; target_type: string | null };
const WIN: Record<string, string> = { london_q: "London Q", ny_q: "NY Q", other: "Outside" };
const BREAKS = ["chased", "no sweep", "counter-trend", "off-window", "moved stop", "stretched TP", "over-size", "revenge", "news"];
const EMOTIONS = ["calm", "confident", "fearful", "greedy", "FOMO", "hopeful", "revenge", "doubt"];
const dotColor = (s: string) => (s === "pass" ? "var(--up)" : s === "fail" ? "var(--down)" : s === "warn" ? "var(--warn)" : "var(--surface-3)");

function Schematic({ t }: { t: T }) {
  const e = Number(t.entry), s = Number(t.stop), tp = t.target !== null ? Number(t.target) : null, x = t.exit !== null ? Number(t.exit) : null;
  const vals = [e, s, ...(tp !== null ? [tp] : []), ...(x !== null ? [x] : [])];
  const lo = Math.min(...vals), hi = Math.max(...vals), sp = hi - lo || 1;
  const y = (v: number) => 12 + (1 - (v - lo) / sp) * 126;
  const lvl = (v: number, c: string, l: string) => <g key={l}><line x1="0" x2="200" y1={y(v)} y2={y(v)} stroke={c} strokeDasharray="4 3" /><text x="4" y={y(v) - 3} fontSize="9" fill={c} fontFamily="var(--font-geist-mono)">{l} {num(v, 2)}</text></g>;
  return (
    <svg viewBox="0 0 200 150" style={{ width: "100%", height: 150, borderRadius: 12, background: "var(--surface-2)", border: "1px solid var(--line)" }} aria-label="Trade levels">
      {tp !== null && <rect x="60" width="140" y={Math.min(y(e), y(tp))} height={Math.abs(y(tp) - y(e))} fill="var(--up-bg)" />}
      <rect x="60" width="140" y={Math.min(y(e), y(s))} height={Math.abs(y(s) - y(e))} fill="var(--down-bg)" />
      {lvl(e, "var(--accent)", "Entry")}{lvl(s, "var(--down)", "Stop")}{tp !== null && lvl(tp, "var(--up)", "TP")}
      {x !== null && <><line x1="60" x2="200" y1={y(e)} y2={y(x)} stroke="var(--text)" strokeWidth="1.5" /><circle cx="196" cy={y(x)} r="3" fill="var(--text)" /></>}
    </svg>
  );
}

const blank = { account_id: "", instrument: "XAUUSD", side: "long", model: "A", session: "ny_q", qty: "", entry: "", stop: "", target: "", exit: "", pnl: "", fees: "", mood: "7", grade: "A+", planFollowed: true, emotion: "calm", sweep: "", zone: "discount", targetType: "PDH", review: "", lesson: "" };

export default function Journal() {
  const trades = useRows<T>({ table: "trades", order: "opened_at", limit: 1000 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,currency,type", order: "created_at", ascending: true });
  const [fm, setFm] = useState({ model: "all", win: "all", inst: "all", breaks: false, mood: "all" });
  const [sel, setSel] = useState<string | null>(null);
  const [log, setLog] = useState(false);
  const [f, setF] = useState(blank);
  const [brk, setBrk] = useState<string[]>([]);
  const [edit, setEdit] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const all = trades.rows ?? [];
  const rows = all.filter((t) => (fm.model === "all" || t.model === fm.model) && (fm.win === "all" || t.session_window === fm.win) && (fm.inst === "all" || t.instrument === fm.inst) && (!fm.breaks || t.rule_breaks.length > 0) && (fm.mood === "all" || (t.mood !== null && (fm.mood === "low" ? t.mood <= 4 : fm.mood === "mid" ? t.mood >= 5 && t.mood <= 7 : t.mood >= 8))));
  const t = all.find((x) => x.id === sel) ?? rows[0] ?? null;
  const acc = (id: string) => (accounts.rows ?? []).find((a) => a.id === id);

  const preview = useMemo(() => {
    const e = toNum(f.entry), s = toNum(f.stop), tp = toNum(f.target), x = toNum(f.exit);
    let planned: number | null = null;
    try { if (e > 0 && s > 0 && tp > 0) planned = rewardToRisk(e, s, tp); } catch { planned = null; }
    return { planned, realized: e > 0 && s > 0 && x > 0 ? realizedR(f.side as "long" | "short", e, s, x) : null };
  }, [f]);

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const entry = toNum(f.entry), stop = toNum(f.stop), qty = toNum(f.qty);
    if (!f.account_id || !(entry > 0) || !(stop > 0) || !(qty > 0)) return setMsg({ ok: false, t: "Account, qty, entry and stop are required" });
    const exit = f.exit ? toNum(f.exit) : null;
    const { error } = await supabase.from("trades").insert({
      account_id: f.account_id, instrument: f.instrument, side: f.side, model: f.model, session_window: f.session, qty, entry, stop,
      target: f.target ? toNum(f.target) : null, exit, planned_r: preview.planned !== null ? Number(preview.planned.toFixed(3)) : null,
      realized_r: preview.realized !== null ? Number(preview.realized.toFixed(3)) : null, pnl: f.pnl ? toNum(f.pnl) : null, fees: f.fees ? toNum(f.fees) : null,
      rule_breaks: brk, mood: Number(f.mood) || null, grade: f.grade, plan_followed: f.planFollowed, emotion: f.emotion, sweep_type: f.sweep || null, htf_zone: f.zone,
      target_type: f.targetType, review: f.review.trim() || null, lesson: f.lesson.trim() || null, closed_at: exit ? new Date().toISOString() : null, edge_version: "1.1",
    });
    if (error) return setMsg({ ok: false, t: error.message });
    setMsg({ ok: true, t: "Trade logged" }); setLog(false); setF({ ...blank, account_id: f.account_id }); setBrk([]); trades.reload();
  };
  const saveReview = async () => {
    if (!t || edit === null) return;
    await supabase.from("trades").update({ review: edit.trim() || null }).eq("id", t.id);
    setEdit(null); trades.reload();
  };
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const chipSel = (k: keyof typeof fm, label: string, opts: [string, string][]) => (
    <select className={`chip ${fm[k] !== "all" ? "acc" : ""}`} aria-label={label} value={String(fm[k])} onChange={(e) => setFm({ ...fm, [k]: e.target.value })}>
      <option value="all">{label}: all</option>{opts.map(([v, l]) => <option key={v} value={v}>{label}: {l}</option>)}
    </select>
  );

  return (
    <>
      <ErrorNote error={trades.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <div className="row">
        {chipSel("model", "Model", MODEL_IDS.map((m) => [m, ENTRY_MODELS[m].short]))}
        {chipSel("win", "Window", [["london_q", "London Q"], ["ny_q", "NY Q"], ["other", "Outside"]])}
        {chipSel("inst", "Instrument", [["XAUUSD", "XAUUSD"], ["BTCUSDT.P", "BTCUSDT.P"], ["GOLDM", "GOLDM"]])}
        <button className={`chip ${fm.breaks ? "down" : ""}`} onClick={() => setFm({ ...fm, breaks: !fm.breaks })}>Rule breaks only</button>
        {chipSel("mood", "Mood", [["low", "1–4"], ["mid", "5–7"], ["high", "8–10"]])}
        <span style={{ flex: 1 }} />
        <span className="faint hide-m" style={{ fontSize: 12 }}>Gate dots: green pass · amber soft · red failed</span>
        <button className="btn pri sm" onClick={() => setLog(true)}>Log trade</button>
      </div>

      <section className="g12">
        <div className="card flush s8">
          {rows.length === 0 ? <div style={{ padding: 16 }}><Empty>No trades</Empty></div> : (
            <Table head={["Date", "Instrument", "Model", "Window", "Gate 1–7", "Planned", "Realised", "Target", "Rule breaks", "Mood"]} right={[5, 6]}>
              {rows.map((x) => (
                <tr key={x.id} onClick={() => setSel(x.id)} style={{ cursor: "pointer", background: t?.id === x.id ? "var(--accent-bg)" : undefined }}>
                  <td className="mono faint">{dateShort(x.opened_at)}</td>
                  <td><b style={{ fontWeight: 500 }}>{x.instrument}</b> <span className={x.side === "long" ? "up" : "down"}>{x.side}</span></td>
                  <td>{x.model ?? "—"}</td>
                  <td className="muted">{WIN[x.session_window ?? ""] ?? "—"}</td>
                  <td><span style={{ display: "inline-flex", gap: 3 }}>{(x.gate ?? Array.from({ length: 7 }, (_, i) => ({ n: i + 1, status: "none" }))).slice(0, 7).map((g, i) => <i key={i} style={{ width: 8, height: 8, borderRadius: 2, display: "block", background: dotColor(g.status) }} />)}</span></td>
                  <td className="r mono">{x.planned_r !== null ? `${num(Number(x.planned_r), 2)}R` : "—"}</td>
                  <td className={`r mono ${Number(x.realized_r) >= 0 ? "up" : "down"}`}>{x.realized_r !== null ? `${Number(x.realized_r) > 0 ? "+" : ""}${num(Number(x.realized_r), 2)}R` : <Chip tone="acc">open</Chip>}</td>
                  <td className="muted">{x.target_type ?? "—"}</td>
                  <td>{x.rule_breaks.length ? <Chip tone="down">{x.rule_breaks.join(", ")}</Chip> : <Chip tone="up">none</Chip>}</td>
                  <td className="mono">{x.mood ?? "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>

        <div className="card s4 col" style={{ gap: 12 }}>
          {!t ? <Empty>Select a trade</Empty> : (
            <>
              <div className="between">
                <div className="col" style={{ gap: 2 }}><b style={{ fontSize: 15 }}>{t.instrument} · {t.side}</b><span className="faint" style={{ fontSize: 12 }}>{dateShort(t.opened_at)} · {t.model ? `Model ${t.model}` : "—"} · {WIN[t.session_window ?? ""] ?? "—"} · {acc(t.account_id)?.name ?? ""}</span></div>
                <Chip tone={t.realized_r === null ? "acc" : Number(t.realized_r) >= 0 ? "up" : "down"}>{t.realized_r === null ? "open" : `${Number(t.realized_r) > 0 ? "+" : ""}${num(Number(t.realized_r), 2)}R`}</Chip>
              </div>
              <Schematic t={t} />
              <div className="lbl-u">Gate result</div>
              {t.gate && t.gate.length ? (
                <div className="col" style={{ gap: 0 }}>
                  {t.gate.map((g) => <div key={g.n} className="gate" style={{ padding: "6px 0" }}><span className={`gi ${g.status === "pass" ? "p" : g.status === "fail" ? "f" : g.status === "warn" ? "w" : ""}`}>{g.n}</span><span style={{ fontSize: 12.5 }}>{g.label}</span><span className="faint mono" style={{ fontSize: 11 }}>{g.status}</span></div>)}
                </div>
              ) : <span className="faint" style={{ fontSize: 12 }}>Logged by hand · grade {t.grade ?? "—"}</span>}
              <div className="auto-s" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8 }}>
                <div><div className="lbl">Sweep</div><b style={{ fontSize: 12.5 }}>{t.sweep_type ?? "—"}</b></div>
                <div><div className="lbl">HTF zone</div><b style={{ fontSize: 12.5 }}>{t.htf_zone ?? "—"}</b></div>
                <div><div className="lbl">P&amp;L</div><b className="mono" style={{ fontSize: 12.5 }}>{t.pnl !== null ? money(Number(t.pnl), acc(t.account_id)?.currency ?? "USD") : "—"}</b></div>
                <div><div className="lbl">Plan followed</div><b style={{ fontSize: 12.5 }}>{t.plan_followed === null ? "—" : t.plan_followed ? "yes" : "no"}</b></div>
                <div><div className="lbl">Emotion</div><b style={{ fontSize: 12.5 }}>{t.emotion ?? "—"}</b></div>
                <div><div className="lbl">Grade</div><b style={{ fontSize: 12.5 }}>{t.grade ?? "—"}</b></div>
              </div>
              <div className="col" style={{ gap: 5 }}>
                <div className="between"><span className="lbl">Review line</span>{edit === null ? <button className="btn ghost sm" onClick={() => setEdit(t.review ?? "")}>Edit</button> : <button className="btn pri sm" onClick={saveReview}>Save</button>}</div>
                {edit === null ? <p style={{ fontSize: 13, padding: "10px 12px", borderRadius: 12, background: "var(--surface-2)", border: "1px solid var(--line)" }}>{t.review ?? "—"}</p> : <textarea className="inp" value={edit} onChange={(e) => setEdit(e.target.value)} />}
                {t.lesson && <span className="muted" style={{ fontSize: 12 }}>Lesson: {t.lesson}</span>}
              </div>
            </>
          )}
        </div>
      </section>

      {log && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Log trade">
          <form className="card" style={{ maxWidth: 720 }} onSubmit={save}>
            <div className="ch"><h3>Log trade</h3><span className="sp" /><span className="mono" style={{ fontSize: 12 }}>{preview.planned !== null ? `${num(preview.planned, 2)}R planned` : ""}{preview.realized !== null ? ` · ${preview.realized > 0 ? "+" : ""}${num(preview.realized, 2)}R` : ""}</span><button type="button" className="btn ghost sm" onClick={() => setLog(false)}>Close</button></div>
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))" }}>
              <label className="fld"><span>Account</span><div className="inp"><select value={f.account_id} onChange={set("account_id")}><option value="">—</option>{(accounts.rows ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div></label>
              <label className="fld"><span>Instrument</span><div className="inp"><select value={f.instrument} onChange={set("instrument")}>{["XAUUSD", "BTCUSDT.P", "GOLDM", "GOLD"].map((i) => <option key={i}>{i}</option>)}</select></div></label>
              <label className="fld"><span>Side</span><div className="inp"><select value={f.side} onChange={set("side")}><option value="long">Long</option><option value="short">Short</option></select></div></label>
              <label className="fld"><span>Model</span><div className="inp"><select value={f.model} onChange={set("model")}>{MODEL_IDS.map((m) => <option key={m} value={m}>{ENTRY_MODELS[m].short} · {ENTRY_MODELS[m].name}</option>)}</select></div></label>
              <label className="fld"><span>Window</span><div className="inp"><select value={f.session} onChange={set("session")}><option value="london_q">London Q</option><option value="ny_q">NY Q</option><option value="other">Outside</option></select></div></label>
              <label className="fld"><span>Grade</span><div className="inp"><select value={f.grade} onChange={set("grade")}>{["A+", "A", "B", "C"].map((g) => <option key={g}>{g}</option>)}</select></div></label>
              {(["qty", "entry", "stop", "target", "exit", "pnl", "fees"] as const).map((k) => <label key={k} className="fld"><span style={{ textTransform: "capitalize" }}>{k === "pnl" ? "P&L" : k}</span><div className="inp"><input inputMode="decimal" value={f[k]} onChange={set(k)} /></div></label>)}
              <label className="fld"><span>Sweep</span><div className="inp txt"><input placeholder="PDL, EQL, Asia low…" value={f.sweep} onChange={set("sweep")} /></div></label>
              <label className="fld"><span>HTF zone</span><div className="inp"><select value={f.zone} onChange={set("zone")}><option value="discount">Discount</option><option value="premium">Premium</option><option value="mid">Mid</option></select></div></label>
              <label className="fld"><span>Target type</span><div className="inp"><select value={f.targetType} onChange={set("targetType")}>{["PDH", "PDL", "15M swing", "Opposing zone", "Unfilled FVG", "Range high", "Range low"].map((x) => <option key={x}>{x}</option>)}</select></div></label>
              <label className="fld"><span>Emotion</span><div className="inp"><select value={f.emotion} onChange={set("emotion")}>{EMOTIONS.map((x) => <option key={x}>{x}</option>)}</select></div></label>
              <label className="fld"><span>Mood · {f.mood}</span><input type="range" min={1} max={10} value={f.mood} onChange={set("mood")} style={{ accentColor: "var(--accent)", height: 38 }} /></label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className={`chip ${f.planFollowed ? "up" : "down"}`} onClick={() => setF({ ...f, planFollowed: !f.planFollowed })}>Plan followed: {f.planFollowed ? "yes" : "no"}</button>
              {BREAKS.map((b) => <button key={b} type="button" className={`chip ${brk.includes(b) ? "down" : ""}`} onClick={() => setBrk((x) => (x.includes(b) ? x.filter((y) => y !== b) : [...x, b]))}>{b}</button>)}
            </div>
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))", marginTop: 10 }}>
              <label className="fld"><span>Review line</span><textarea className="inp" value={f.review} onChange={set("review")} /></label>
              <label className="fld"><span>One lesson</span><textarea className="inp" value={f.lesson} onChange={set("lesson")} /></label>
            </div>
            <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}><button className="btn pri">Save trade</button></div>
          </form>
        </div>
      )}
    </>
  );
}
