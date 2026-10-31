"use client";

import { useState } from "react";
import { summarize } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { istDay, todayIst } from "@/lib/derive";
import { useMe } from "@/components/Shell";
import type { Trade, TradingAccount } from "@/lib/types";
import { num } from "@/lib/fmt";
import { Bar, Card, Chip, Empty, ErrorNote, Note } from "@/components/ui";

type Checkin = { id: string; phase: "pre" | "post"; score: number; tags: string[]; sleep_hours: number | null; note: string | null; at: string };
const TAGS = ["Calm", "Focused", "Tired", "Anxious", "FOMO", "Revenge urge", "Distracted", "Confident"];
const rfmt = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}R`;
const clean = (t: Trade) => t.rule_breaks.length === 0 && t.plan_followed !== false;

function pearson(xs: number[], ys: number[]) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2; }
  return sxx && syy ? { r: sxy / Math.sqrt(sxx * syy), slope: sxy / sxx, icpt: my - (sxy / sxx) * mx } : null;
}

export default function Discipline() {
  const me = useMe();
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 3000 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,type" });
  const checks = useRows<Checkin>({ table: "mood_checkins", order: "at", limit: 500 });
  const [phase, setPhase] = useState<"pre" | "post">("pre");
  const [score, setScore] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [sleep, setSleep] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const masters = new Set((accounts.rows ?? []).filter((a) => a.type === "master").map((a) => a.id));
  const tr = (trades.rows ?? []).filter((t) => masters.has(t.account_id) && t.realized_r !== null);
  const now = Date.now();
  const last30 = tr.filter((t) => +new Date(t.opened_at) >= now - 30 * 86_400_000);
  const prior30 = tr.filter((t) => +new Date(t.opened_at) < now - 30 * 86_400_000 && +new Date(t.opened_at) >= now - 60 * 86_400_000);
  const scoreOf = (xs: Trade[]) => (xs.length ? Math.round((xs.filter(clean).length / xs.length) * 100) : null);
  const s30 = scoreOf(last30), sPrior = scoreOf(prior30);
  const compliant = last30.filter(clean), broke = last30.filter((t) => !clean(t));
  // process-followed streak in days (most recent days with only clean trades)
  const days = Array.from(new Set(tr.map((t) => istDay(t.opened_at)))).sort().reverse();
  let streak = 0;
  for (const d of days) { if (tr.filter((t) => istDay(t.opened_at) === d).every(clean)) streak++; else break; }
  const types = new Map<string, number>();
  for (const t of last30) { for (const b of t.rule_breaks) types.set(b, (types.get(b) ?? 0) + 1); if (t.plan_followed === false && !t.rule_breaks.length) types.set("plan not followed", (types.get("plan not followed") ?? 0) + 1); }
  const tmax = Math.max(1, ...types.values());
  const eC = summarize(compliant.map((t) => Number(t.realized_r))), eB = summarize(broke.map((t) => Number(t.realized_r)));
  const luckyWins = broke.filter((t) => Number(t.realized_r) > 0).length;

  // mood vs daily result (pre-session check-ins)
  const pre = (checks.rows ?? []).filter((c) => c.phase === "pre");
  const dayR = new Map<string, number>();
  for (const t of tr) { const d = istDay(t.closed_at ?? t.opened_at); dayR.set(d, (dayR.get(d) ?? 0) + Number(t.realized_r)); }
  const pts = pre.map((c) => ({ m: c.score, r: dayR.get(istDay(c.at)) })).filter((p): p is { m: number; r: number } => p.r !== undefined);
  const fit = pearson(pts.map((p) => p.m), pts.map((p) => p.r));
  const X = (m: number) => 40 + ((m - 1) / 9) * 350, Y = (r: number) => 110 - Math.max(-2, Math.min(4, r)) * (r >= 0 ? 25 : 45);
  const low = pts.filter((p) => p.m <= 5), high = pts.filter((p) => p.m >= 6);
  const avg = (xs: { r: number }[]) => (xs.length ? xs.reduce((s, p) => s + p.r, 0) / xs.length : null);
  const todayPre = pre.find((c) => istDay(c.at) === todayIst());

  const advice = score === null ? { t: "Pick a number", c: "" } : score <= 4 ? { t: "Confirm before every order today", c: "down" } : score <= 6 ? { t: "Trade A+ only, base risk", c: "warn" } : { t: "Clear to follow the plan", c: "up" };
  const save = async () => {
    if (score === null) return;
    const { error } = await supabase.from("mood_checkins").insert({ user_id: me.session.user.id, phase, score, tags, sleep_hours: sleep ? Number(sleep) : null, note: note.trim() || null });
    setMsg(error ? { ok: false, t: error.message } : { ok: true, t: "Check-in saved" });
    if (!error) { setScore(null); setTags([]); setNote(""); checks.reload(); }
  };

  return (
    <>
      <ErrorNote error={trades.error || checks.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="g12">
        <Card span={4} title="Discipline score" right={s30 !== null && sPrior !== null ? <Chip tone={s30 >= sPrior ? "up" : "down"}>{s30 >= sPrior ? "+" : ""}{s30 - sPrior} vs prior 30d</Chip> : null}>
          {s30 === null ? <Empty>No closed master trades in 30 days</Empty> : (
            <div className="row" style={{ gap: 20, flexWrap: "nowrap" }}>
              <svg width="132" height="132" viewBox="0 0 132 132" role="img" aria-label={`Discipline score ${s30} out of 100`}>
                <circle cx="66" cy="66" r="56" fill="none" stroke="var(--surface-3)" strokeWidth="12" />
                <circle cx="66" cy="66" r="56" fill="none" stroke="var(--accent)" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${(s30 / 100) * 351.86} 351.86`} transform="rotate(-90 66 66)" />
                <text x="66" y="74" textAnchor="middle" fontFamily="var(--font-geist-mono)" fontSize="30" fontWeight="600" fill="var(--text)">{s30}</text>
              </svg>
              <div className="col" style={{ gap: 8 }}>
                <div><div className="lbl">A+ compliant trades</div><b className="mono">{compliant.length} / {last30.length}</b></div>
                <div><div className="lbl">Rule-break trades</div><b className="mono warn">{broke.length}</b></div>
                <div><div className="lbl">Process-followed streak</div><b className="mono">{streak} day{streak === 1 ? "" : "s"}</b></div>
              </div>
            </div>
          )}
        </Card>
        <Card span={4} title="Rule breaks by type">
          {types.size === 0 ? <Empty>No rule breaks in 30 days</Empty> : Array.from(types).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
            <div key={t} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 120px 40px", gap: 10, alignItems: "center", fontSize: 12.5, padding: "7px 0" }}>
              <span style={{ textTransform: "capitalize" }}>{t}</span><Bar pct={(n / tmax) * 100} tone="warn" /><span className="mono" style={{ textAlign: "right" }}>{n}</span>
            </div>
          ))}
        </Card>
        <Card span={4} title="Does breaking rules pay?">
          <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <div className="card" style={{ background: "var(--surface-2)" }}><div className="lbl">Compliant · {compliant.length} trades</div><div className={`kv sm ${eC.avgR >= 0 ? "up" : "down"}`}>{compliant.length ? rfmt(eC.avgR) : "—"}</div><div className="faint" style={{ fontSize: 11 }}>expectancy</div></div>
            <div className="card" style={{ background: "var(--surface-2)" }}><div className="lbl">Rule breaks · {broke.length} trades</div><div className={`kv sm ${eB.avgR >= 0 ? "up" : "down"}`}>{broke.length ? rfmt(eB.avgR) : "—"}</div><div className="faint" style={{ fontSize: 11 }}>expectancy</div></div>
          </div>
          {broke.length > 0 && <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>{luckyWins} of the {broke.length} rule-break trades were winners. They still count as breaks.</p>}
        </Card>
      </section>

      <section className="g12">
        <Card span={6} title="Mood check-in" right={<div className="seg" role="group" aria-label="Check-in">{(["pre", "post"] as const).map((p) => <button key={p} type="button" className={phase === p ? "on" : ""} onClick={() => setPhase(p)}>{p === "pre" ? "Pre-session" : "Post-session"}</button>)}</div>}>
          {todayPre && phase === "pre" && <div className="banner info" style={{ marginBottom: 10 }}><span className="dot" />Today&apos;s pre-session check-in: {todayPre.score}/10</div>}
          <div className="lbl" style={{ marginBottom: 6 }}>How settled do you feel? (1 = rattled, 10 = calm and focused)</div>
          <div role="group" aria-label="Mood 1 to 10" style={{ display: "grid", gridTemplateColumns: "repeat(10, minmax(0, 1fr))", gap: 6 }}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <button key={n} type="button" aria-pressed={score === n} onClick={() => setScore(n)} className="mono" style={{ height: 40, borderRadius: 12, border: `1px solid ${score === n ? "transparent" : "var(--line-2)"}`, background: score === n ? "var(--accent)" : "var(--surface-2)", color: score === n ? "var(--on-accent)" : "var(--muted)", fontWeight: 600 }}>{n}</button>
            ))}
          </div>
          <div className="lbl" style={{ margin: "14px 0 6px" }}>What&apos;s present?</div>
          <div className="row" style={{ gap: 6 }}>
            {TAGS.map((g) => <button key={g} type="button" aria-pressed={tags.includes(g)} className={`chip ${tags.includes(g) ? "acc" : ""}`} style={{ height: 32, padding: "0 12px" }} onClick={() => setTags((x) => (x.includes(g) ? x.filter((y) => y !== g) : [...x, g]))}>{g}</button>)}
          </div>
          <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginTop: 14 }}>
            <label className="fld"><span>Sleep last night</span><div className="inp"><input inputMode="decimal" value={sleep} onChange={(e) => setSleep(e.target.value)} /><span className="u">hours</span></div></label>
            <label className="fld"><span>One line</span><div className="inp txt"><input value={note} placeholder="Anything on your mind?" onChange={(e) => setNote(e.target.value)} /></div></label>
          </div>
          <div className="between" style={{ marginTop: 14 }}><Chip tone={advice.c as "up" | "down" | "warn" | ""}>{advice.t}</Chip><button className="btn pri" disabled={score === null} onClick={save}>Save check-in</button></div>
        </Card>
        <Card span={6} title="Mood vs daily result" right={<span className="mono faint" style={{ fontSize: 12 }}>r = {fit ? num(fit.r, 2) : "—"} · {pts.length} days</span>}>
          {pts.length < 3 ? <Empty>Check in before sessions to see the link</Empty> : (
            <>
              <svg viewBox="0 0 400 220" style={{ width: "100%", height: 240, display: "block" }} role="img" aria-label="Pre-session mood against daily net R">
                <line x1="40" y1="110" x2="390" y2="110" stroke="var(--line-2)" strokeDasharray="4 4" />
                <line x1="40" y1="10" x2="40" y2="200" stroke="var(--line)" />
                {pts.map((p, i) => <circle key={i} cx={X(p.m)} cy={Y(p.r)} r="4" fill="var(--accent)" />)}
                {fit && <path d={`M${X(1)},${Y(fit.icpt + fit.slope)} L${X(10)},${Y(fit.icpt + fit.slope * 10)}`} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="5 4" fill="none" />}
                <text x="40" y="216" fontSize="10" fill="var(--faint)" fontFamily="var(--font-geist-mono)">mood 1</text>
                <text x="350" y="216" fontSize="10" fill="var(--faint)" fontFamily="var(--font-geist-mono)">mood 10</text>
                <text x="4" y="14" fontSize="10" fill="var(--faint)" fontFamily="var(--font-geist-mono)">+4R</text>
                <text x="4" y="114" fontSize="10" fill="var(--faint)" fontFamily="var(--font-geist-mono)">0R</text>
                <text x="4" y="204" fontSize="10" fill="var(--faint)" fontFamily="var(--font-geist-mono)">−2R</text>
              </svg>
              <p className="muted" style={{ fontSize: 12.5 }}>Check-ins at 5 or below average {avg(low) !== null ? rfmt(avg(low)!) : "—"} versus {avg(high) !== null ? rfmt(avg(high)!) : "—"} at 6 and above. At 4 or lower the copilot asks you to confirm before any order.</p>
            </>
          )}
        </Card>
      </section>
    </>
  );
}
