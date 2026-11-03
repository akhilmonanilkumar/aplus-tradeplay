"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { staffGet, staffPost } from "@/lib/market";
import { num, timeShort } from "@/lib/fmt";
import { Chip, ErrorNote } from "@/components/ui";
import type { Forming, LiveAlert, LiveBoard } from "@/lib/server/cfdLive";
import type { LiveOutcome } from "@/lib/cfdLive";

/**
 * Dashboard: CFD live board. Confirmed CFD setups from the moment they arm, marked to the live price:
 * where the entry, stop and targets are now (they follow the detector until the fill), when to place the
 * order, the trade once filled, and how it ended. Setups still forming sit underneath. Polls every 5 s.
 */

const POLL_MS = 5_000;
const IST = "Asia/Kolkata";

const OUTCOME: Record<LiveOutcome, { l: string; tone: "up" | "down" | "warn" | "" }> = {
  win: { l: "Won · TP2", tone: "up" }, partial: { l: "TP1 · then stop", tone: "up" }, loss: { l: "Stopped out", tone: "down" },
  expired: { l: "Expired", tone: "" }, ran_away: { l: "Ran away", tone: "warn" }, dead: { l: "Dead", tone: "down" },
};
const STAGES = ["IN_POI", "SWEPT", "SHIFTED", "ARMED"] as const;
const STAGE_L: Record<string, string> = { IN_POI: "In POI", SWEPT: "Swept", SHIFTED: "Shifted", ARMED: "Armed" };

const px = (v: number, d: number) => num(v, d);
const signedR = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${num(v, 2)}R`);
function left(ms: number) {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60_000), s = Math.floor((ms % 60_000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m >= 1 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};

function useBoard() {
  const [d, setD] = useState<LiveBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try { const x = await staffGet<LiveBoard>("/api/cfd/live"); if (!stop) { setD(x); setError(null); } } catch (e) { if (!stop) setError((e as Error).message); }
      }
      if (!stop) timer = setTimeout(load, POLL_MS);
    };
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [tick]);
  return { d, error, reload: () => setTick((t) => t + 1) };
}

/** A clock that ticks every second, for countdowns between polls. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return now;
}

/** Stop → TP2 ladder: loss zone, profit zone, entry and TP1 ticks, and the live price. */
function Ladder({ a }: { a: LiveAlert }) {
  const lo = Math.min(a.stop, a.tp2), hi = Math.max(a.stop, a.tp2), span = hi - lo || 1;
  // Long: stop on the left. Short: flip so the stop is still on the left and profit runs right.
  const P = (v: number) => { const x = ((v - lo) / span) * 100; return a.side === "long" ? x : 100 - x; };
  const e = P(a.entry), t1 = P(a.tp1);
  const raw = a.price === null ? null : P(a.price);
  const p = raw === null ? null : Math.max(0, Math.min(100, raw));
  return (
    <div className="lad" aria-label={`Stop ${a.stop}, entry ${a.entry}, TP1 ${a.tp1}, TP2 ${a.tp2}${a.price !== null ? `, price ${a.price}` : ""}`}>
      <div className="lad-t">
        <i className="z down" style={{ left: 0, width: `${e}%` }} />
        <i className="z up" style={{ left: `${e}%`, width: `${100 - e}%` }} />
        <b className="m" style={{ left: `${e}%` }} />
        <b className="m faint" style={{ left: `${t1}%` }} />
        {p !== null && <span className={`dot ${raw! < 0 || raw! > 100 ? "out" : ""}`} style={{ left: `${p}%` }} />}
      </div>
      <div className="lad-l"><span style={{ left: 0 }}>SL</span><span style={{ left: `${e}%` }}>Entry</span><span style={{ left: `${t1}%` }}>TP1</span><span style={{ left: "100%" }}>TP2</span></div>
    </div>
  );
}

function Phase({ a }: { a: LiveAlert }) {
  const buy = a.side === "long";
  if (a.phase === "ended" && a.outcome) return <Chip tone={OUTCOME[a.outcome].tone}>{OUTCOME[a.outcome].l}</Chip>;
  if (a.phase === "trigger") return <span className={`go ${buy ? "up" : "down"}`}>{buy ? "BUY NOW" : "SELL NOW"}</span>;
  if (a.phase === "in_trade") return <Chip tone="info" dot>In trade{a.tp1Hit ? " · TP1 hit" : ""}</Chip>;
  return <Chip tone="warn" dot>Armed · waiting</Chip>;
}

/** The one line that says what to do now. */
function Instruction({ a, now }: { a: LiveAlert; now: number }) {
  const d = a.digits, buy = a.side === "long";
  const order = `${buy ? "Buy" : "Sell"} limit ${px(a.entry, d)}`;
  if (a.phase === "trigger") return <p className="cl-do hot">Price is at the entry. {order} with SL {px(a.stop, d)} now, if it is not placed already.</p>;
  if (a.phase === "armed") return <p className="cl-do">{order} · price {a.price === null ? "—" : px(a.price, d)}{a.toEntryR !== null ? ` · ${num(Math.abs(a.toEntryR), 2)}R ${a.toEntryR >= 0 ? "away" : "past it"}` : ""} · expires in {left(Date.parse(a.expiresAt) - now)}</p>;
  if (a.phase === "in_trade") return <p className="cl-do">Filled {a.filledAt ? timeShort(Date.parse(a.filledAt), IST) : ""} IST · price {a.price === null ? "—" : px(a.price, d)} · <b className={`mono ${(a.r ?? 0) >= 0 ? "up" : "down"}`}>{signedR(a.r)}</b>{a.tp1Hit ? " · half booked at TP1, rest runs to TP2" : ""}</p>;
  return <p className="cl-do faint">{a.endedReason ?? ""}{a.endedAt ? ` · ${timeShort(Date.parse(a.endedAt), IST)} IST` : ""}{a.r !== null ? ` · ${signedR(a.r)}` : ""}</p>;
}

function Levels({ a, now }: { a: LiveAlert; now: number }) {
  const last = a.revisions.at(-1);
  const fresh = last && now - Date.parse(last.at) < 5 * 60_000;
  const cells: [string, "entry" | "stop" | "tp1" | "tp2", string][] = [["Entry", "entry", ""], ["Stop", "stop", "down"], ["TP1", "tp1", "up"], ["TP2", "tp2", "up"]];
  return (
    <div className="cl-lv">
      {cells.map(([l, k, t]) => {
        const moved = fresh && last && Math.abs(last.from[k] - last.to[k]) > 0;
        return (
          <div key={k} className={moved ? "moved" : ""}>
            <span className="lbl">{l}</span>
            <b className={`mono ${t}`}>{px(a[k], a.digits)}</b>
            {moved && <s className="mono faint">{px(last!.from[k], a.digits)}</s>}
          </div>
        );
      })}
    </div>
  );
}

function AlertCard({ a, now, busy, act, place, canPlace }: { a: LiveAlert; now: number; busy: boolean; act: (id: string, action: "taken" | "skipped") => void; place: (body: { legId?: string; alertId?: string }) => void; canPlace: boolean }) {
  const open = a.phase !== "ended";
  const unfilled = a.phase === "armed" || a.phase === "trigger";
  const placeable = canPlace && unfilled && a.status !== "skipped";
  const ready = a.legs.filter((l) => !l.blocked);
  const tone = a.phase === "trigger" ? (a.side === "long" ? "up" : "down") : a.phase === "in_trade" ? "info" : a.phase === "armed" ? "warn" : "";
  return (
    <div className={`cl-card ${tone} ${open ? "" : "done"}`}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontWeight: 600, fontSize: 15 }}>{a.symbol}</b>
        <Chip tone={a.side === "long" ? "up" : "down"}>{a.side === "long" ? "Long" : "Short"}</Chip>
        {a.grade && <Chip tone="acc">{a.grade}</Chip>}
        <span className="faint" style={{ fontSize: 12 }}>{num(a.rr, 1)}R{a.model ? ` · Model ${a.model}` : ""}</span>
        <span style={{ flex: 1 }} />
        <Phase a={a} />
      </div>
      <Instruction a={a} now={now} />
      <Ladder a={a} />
      <Levels a={a} now={now} />
      <div className="cl-meta">
        <span>Armed {timeShort(Date.parse(a.createdAt), IST)} IST</span>
        {a.revisions.length > 0 && <span className={now - Date.parse(a.revisions.at(-1)!.at) < 5 * 60_000 ? "warn" : ""}>Levels moved {a.revisions.length}× · {ago(a.revisions.at(-1)!.at, now)}</span>}
        {unfilled && a.checkedAt && <span>Setup checked {ago(a.checkedAt, now)}</span>}
        {unfilled && a.strikes > 0 && <span className="down">Setup weakening · one more failed check ends it</span>}
        {a.status === "taken" && <span className="up">Taken</span>}
        {a.status === "skipped" && <span>Skipped</span>}
      </div>
      {open && a.legs.length > 0 && (
        <div className="cl-legs">
          {a.legs.map((l) => (
            <div key={l.accountId} className="between" style={{ gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, minWidth: 0 }}><b style={{ fontWeight: 500 }}>{l.name}</b> {l.blocked ? <span className="down">· {l.blocked}</span> : <span className="muted">· {num(l.lots, 2)} lots · ${num(l.risk, 0)}</span>}</span>
              <span className="row" style={{ gap: 6 }}>
                {l.pending > 0 ? <Chip tone="up" dot>{l.pending} order{l.pending === 1 ? "" : "s"} on cTrader</Chip> : l.action && <Chip tone={l.action === "taken" ? "up" : ""}>{l.action}</Chip>}
                {placeable && !l.blocked && <button type="button" className={`btn sm ${l.pending ? "" : "pri"}`} disabled={busy} onClick={() => place({ legId: l.legId })}>{l.pending ? "Replace" : "Place"}</button>}
                {!placeable && unfilled && l.link && <a className="btn sm" href={l.link} target="_blank" rel="noopener noreferrer">cTrader</a>}
              </span>
              {l.failed && !l.pending && <span className="down" style={{ fontSize: 11.5, flexBasis: "100%" }}>Last order failed: {l.failed}</span>}
            </div>
          ))}
          {placeable && ready.length > 1 && !ready.some((l) => l.pending) && (
            <button type="button" className="btn pri sm" style={{ marginTop: 4 }} disabled={busy} onClick={() => place({ alertId: a.id })}>Place on all {ready.length} accounts</button>
          )}
          {unfilled && a.status === "armed" && !placeable && (
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <button className="btn pri sm" disabled={busy} onClick={() => act(a.id, "taken")}>Taken</button>
              <button className="btn ghost sm" disabled={busy} onClick={() => act(a.id, "skipped")}>Skip</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FormingRow({ f, now }: { f: Forming; now: number }) {
  const at = STAGES.indexOf(f.state as (typeof STAGES)[number]);
  return (
    <div className="cl-form">
      <div className="row" style={{ gap: 8, minWidth: 0 }}>
        <b style={{ fontWeight: 500 }}>{f.symbol}</b>
        <Chip tone={f.side === "long" ? "up" : "down"}>{f.side === "long" ? "Long" : "Short"}</Chip>
      </div>
      <div className="cl-rail" aria-label={`Stage ${STAGE_L[f.state] ?? f.state}`}>
        {STAGES.map((s, i) => <span key={s} className={i < at ? "done" : i === at ? "on" : ""}>{STAGE_L[s]}</span>)}
      </div>
      <span className="faint" style={{ fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {f.blockers[0] ? `Blocked: ${f.blockers[0]}` : f.waitingFor[0] ? `Waiting for ${f.waitingFor[0]}` : f.state === "ARMED" ? "Armed, alert pending the selector" : ""}
        {f.plan ? ` · provisional entry ${px(f.plan.entry, f.digits)}, SL ${px(f.plan.stop, f.digits)}` : ""}
      </span>
      <span className="faint mono" style={{ fontSize: 12 }}>{f.price !== null ? px(f.price, f.digits) : ""} · {ago(f.at, now)}</span>
    </div>
  );
}

const RANK: Record<string, number> = { trigger: 0, in_trade: 1, armed: 2, ended: 3 };

export function CfdLive() {
  const { d, error, reload } = useBoard();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(true);
  const seen = useRef<Set<string>>(new Set());

  // A short beep the first time a setup reaches its entry (once per alert, per page load).
  useEffect(() => {
    for (const a of d?.alerts ?? []) {
      if (a.phase !== "trigger" || seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      try {
        const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = 880; g.gain.value = 0.05; o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.18);
      } catch { /* no audio */ }
    }
  }, [d]);

  const act = async (alertId: string, action: "taken" | "skipped") => {
    setBusy(true); setErr(null);
    try { await staffPost("/api/cfd/alerts", { action, alertId }); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const [placed, setPlaced] = useState<string | null>(null);
  const place = async (body: { legId?: string; alertId?: string }) => {
    setBusy(true); setErr(null); setPlaced(null);
    try { const r = await staffPost<{ message: string }>("/api/cfd/orders", body); setPlaced(r.message); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const canPlace = d?.execMode === "confirm";

  const alerts = [...(d?.alerts ?? [])].sort((a, b) => RANK[a.phase]! - RANK[b.phase]! || Date.parse(b.endedAt ?? b.createdAt) - Date.parse(a.endedAt ?? a.createdAt));
  const live = alerts.filter((a) => a.phase !== "ended");
  const ended = alerts.filter((a) => a.phase === "ended");
  const forming = d?.forming ?? [];
  const count = (p: string) => live.filter((a) => a.phase === p).length;
  const stale = d ? now - d.at > 30_000 : false;

  return (
    <section className="g12"><div className="card s12 cl" aria-live="polite">
      <div className="between" style={{ gap: 10, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 10 }}>
          <span className={`led ${error || stale ? "down" : d ? "live pulse" : ""}`} />
          <h3 style={{ margin: 0, fontSize: 15 }}>CFD live</h3>
          {count("trigger") > 0 && <Chip tone="up">{count("trigger")} at entry</Chip>}
          {count("armed") > 0 && <Chip tone="warn">{count("armed")} armed</Chip>}
          {count("in_trade") > 0 && <Chip tone="info">{count("in_trade")} in trade</Chip>}
          {forming.length > 0 && <Chip>{forming.length} forming</Chip>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="faint mono" style={{ fontSize: 11.5 }}>{d ? `${timeShort(d.at, IST)} IST · 5s` : error ? "unavailable" : "loading…"}</span>
          {ended.length > 0 && <button type="button" className="btn ghost sm" onClick={() => setShowEnded((v) => !v)}>{showEnded ? "Hide" : "Show"} ended ({ended.length})</button>}
          <Link className="btn ghost sm" href="/arena/cfd?tab=alerts">Alerts</Link>
        </div>
      </div>
      <ErrorNote error={error || err} />
      {placed && <p className="up" style={{ fontSize: 12.5, margin: "8px 0 0", whiteSpace: "pre-line" }}>{placed}</p>}
      {d && live.length === 0 && forming.length === 0 && (
        <p className="muted" style={{ fontSize: 13, margin: "12px 0 0" }}>Nothing armed or forming on the CFD markets. Setups appear here from the sweep onwards; confirmed ones get live entry, stop and targets.</p>
      )}
      {(live.length > 0 || (showEnded && ended.length > 0)) && (
        <div className="cl-grid">
          {live.map((a) => <AlertCard key={a.id} a={a} now={now} busy={busy} act={act} place={place} canPlace={canPlace} />)}
          {showEnded && ended.map((a) => <AlertCard key={a.id} a={a} now={now} busy={busy} act={act} place={place} canPlace={canPlace} />)}
        </div>
      )}
      {forming.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Forming</div>
          {forming.map((f) => <FormingRow key={`${f.instrument}:${f.side}`} f={f} now={now} />)}
        </div>
      )}
    </div></section>
  );
}
