"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { staffGet, staffPost } from "@/lib/market";
import { num, timeShort } from "@/lib/fmt";
import { Chip, ErrorNote } from "@/components/ui";
import type { Forming, LiveAlert, LiveBoard } from "@/lib/server/cfdLive";
import type { RankedSetup } from "@/lib/server/cfdSetups";
import type { SetupStatus } from "@/lib/cfdSetups";
import type { LiveOutcome } from "@/lib/cfdLive";

/**
 * Dashboard: the CFD desk, for trading by hand from the board. On top, what to enter now: the best-ranked
 * setups at their entry, with entry, stop and target to copy into cTrader. Then the confirmed A+ alerts
 * (levels follow the detector until the fill, Place on cTrader where it is on), every paper setup of the day
 * ranked by its strategy's record (waiting, running, failed, won), and the setups still forming.
 * Everything is marked to the live price; polls every 5 s.
 */

const POLL_MS = 5_000;
const IST = "Asia/Kolkata";

const OUTCOME: Record<LiveOutcome, { l: string; tone: "up" | "down" | "warn" | "" }> = {
  win: { l: "Won · TP2", tone: "up" }, partial: { l: "TP1 · then stop", tone: "up" }, loss: { l: "Failed · stopped out", tone: "down" },
  expired: { l: "Failed · expired", tone: "down" }, ran_away: { l: "Failed · ran away", tone: "down" }, dead: { l: "Failed · setup broke", tone: "down" },
};
const FAILED = new Set<LiveOutcome>(["loss", "expired", "ran_away", "dead"]);
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

/** Stop → target ladder: loss zone, profit zone, entry (and TP1) ticks, and the live price. */
function Ladder({ side, stop, entry, tp1, target, price }: { side: "long" | "short"; stop: number; entry: number; tp1?: number | null; target: number; price: number | null }) {
  const lo = Math.min(stop, target), hi = Math.max(stop, target), span = hi - lo || 1;
  // Long: stop on the left. Short: flip so the stop is still on the left and profit runs right.
  const P = (v: number) => { const x = ((v - lo) / span) * 100; return side === "long" ? x : 100 - x; };
  const e = P(entry), t1 = tp1 != null ? P(tp1) : null;
  const raw = price === null ? null : P(price);
  const p = raw === null ? null : Math.max(0, Math.min(100, raw));
  return (
    <div className="lad" aria-label={`Stop ${stop}, entry ${entry}${tp1 != null ? `, TP1 ${tp1}` : ""}, target ${target}${price !== null ? `, price ${price}` : ""}`}>
      <div className="lad-t">
        <i className="z down" style={{ left: 0, width: `${e}%` }} />
        <i className="z up" style={{ left: `${e}%`, width: `${100 - e}%` }} />
        <b className="m" style={{ left: `${e}%` }} />
        {t1 !== null && <b className="m faint" style={{ left: `${t1}%` }} />}
        {p !== null && <span className={`dot ${raw! < 0 || raw! > 100 ? "out" : ""}`} style={{ left: `${p}%` }} />}
      </div>
      <div className="lad-l"><span style={{ left: 0 }}>SL</span><span style={{ left: `${e}%` }}>Entry</span>{t1 !== null && <span style={{ left: `${t1}%` }}>TP1</span>}<span style={{ left: "100%" }}>{t1 !== null ? "TP2" : "TP"}</span></div>
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
  const failed = a.phase === "ended" && !!a.outcome && FAILED.has(a.outcome);
  const tone = a.phase === "trigger" ? (a.side === "long" ? "up" : "down") : a.phase === "in_trade" ? "info" : a.phase === "armed" ? "warn" : failed ? "failed" : "";
  return (
    <div className={`cl-card ${tone ? `t-${tone}` : ""} ${open ? "" : "done"}`}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontWeight: 600, fontSize: 15 }}>{a.symbol}</b>
        <Chip tone={a.side === "long" ? "up" : "down"}>{a.side === "long" ? "Long" : "Short"}</Chip>
        {a.grade && <Chip tone="acc">{a.grade}</Chip>}
        <Chip>A+ alert</Chip>
        <span className="faint" style={{ fontSize: 12 }}>{num(a.rr, 1)}R{a.model ? ` · Model ${a.model}` : ""}</span>
        <span style={{ flex: 1 }} />
        <Phase a={a} />
      </div>
      <Instruction a={a} now={now} />
      <Ladder side={a.side} stop={a.stop} entry={a.entry} tp1={a.tp1} target={a.tp2} price={a.price} />
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


const SETUP_CHIP: Record<SetupStatus, { l: string; tone: "up" | "down" | "warn" | "info" | "" }> = {
  enter: { l: "Enter now", tone: "up" }, waiting: { l: "Waiting", tone: "warn" }, in_trade: { l: "Running", tone: "info" }, won: { l: "Won", tone: "up" }, failed: { l: "Failed", tone: "down" },
};

function ticket(x: { symbol: string; side: "long" | "short"; entry: number; stop: number; target: number; digits: number; market?: boolean }) {
  const d = x.digits;
  return `${x.symbol} ${x.side === "long" ? "BUY" : "SELL"} ${x.market ? "MARKET" : "LIMIT"} ${px(x.entry, d)} · SL ${px(x.stop, d)} · TP ${px(x.target, d)}`;
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="btn ghost sm" title={text} onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* no clipboard */ } }}>
      {ok ? "Copied" : "Copy"}
    </button>
  );
}

function EdgeBadge({ s }: { s: RankedSetup }) {
  return (
    <span className={`edge ${s.edge.winning ? "win" : s.edge.score < 0 ? "neg" : ""}`} title={s.edge.label}>
      {s.edge.winning ? "Winning" : s.edge.score < 0 ? "Losing" : "Unproven"} · {s.edge.score > 0 ? "+" : ""}{num(s.edge.score, 2)}R
    </span>
  );
}

/** What to do with a setup, in one line. */
function setupLine(s: RankedSetup, now: number) {
  const d = s.digits, buy = s.side === "long";
  if (s.status === "enter" && s.lateOk) return `Filled on paper at ${px(s.entry, d)}; price ${s.price === null ? "—" : px(s.price, d)} is still within ${num(Math.abs(s.r ?? 0), 2)}R. ${buy ? "Buy" : "Sell"} at market, SL ${px(s.stop, d)}, TP ${px(s.target, d)}.`;
  if (s.status === "enter") return `Price is at the entry. ${buy ? "Buy" : "Sell"} limit ${px(s.entry, d)}, SL ${px(s.stop, d)}, TP ${px(s.target, d)}${s.expiresAt ? ` · expires in ${left(Date.parse(s.expiresAt) - now)}` : ""}.`;
  if (s.status === "waiting") return `${buy ? "Buy" : "Sell"} limit ${px(s.entry, d)} · price ${s.price === null ? "—" : px(s.price, d)}${s.toEntryR !== null ? ` · ${num(s.toEntryR, 2)}R away` : ""}${s.expiresAt ? ` · expires in ${left(Date.parse(s.expiresAt) - now)}` : ""}`;
  if (s.status === "in_trade") return `Running on paper since ${timeShort(Date.parse(s.filledAt ?? s.createdAt), IST)} IST · ${signedR(s.r)}`;
  return `${s.reason}${s.closedAt ? ` · ${timeShort(Date.parse(s.closedAt), IST)} IST` : ""}${s.r !== null ? ` · ${signedR(s.r)}` : ""}`;
}

/** A setup to take now: the ticket, the ladder and the levels. */
function SetupCard({ s, now, fresh }: { s: RankedSetup; now: number; fresh: boolean }) {
  const d = s.digits;
  return (
    <div className={`cl-card ${s.side === "long" ? "t-up" : "t-down"} ${fresh ? "fresh" : ""}`}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {s.rank !== null && <span className="rk">#{s.rank}</span>}
        <b style={{ fontWeight: 600, fontSize: 15 }}>{s.symbol}</b>
        <Chip tone={s.side === "long" ? "up" : "down"}>{s.side === "long" ? "Long" : "Short"}</Chip>
        <span className="faint" style={{ fontSize: 12 }}>{num(s.rr, 1)}R</span>
        <span style={{ flex: 1 }} />
        <span className={`go ${s.side === "long" ? "up" : "down"}`}>{s.lateOk ? (s.side === "long" ? "BUY MKT" : "SELL MKT") : s.side === "long" ? "BUY NOW" : "SELL NOW"}</span>
      </div>
      <div className="between" style={{ gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</span>
        <EdgeBadge s={s} />
      </div>
      <p className="cl-do hot">{setupLine(s, now)}</p>
      <Ladder side={s.side} stop={s.stop} entry={s.entry} target={s.target} price={s.price} />
      <div className="cl-lv">
        <div><span className="lbl">Entry</span><b className="mono">{px(s.entry, d)}</b></div>
        <div><span className="lbl">Stop</span><b className="mono down">{px(s.stop, d)}</b></div>
        <div><span className="lbl">Target</span><b className="mono up">{px(s.target, d)}</b></div>
        <div><span className="lbl">Price</span><b className="mono">{s.price === null ? "—" : px(s.price, d)}</b></div>
      </div>
      <div className="between" style={{ gap: 8 }}>
        <span className="cl-meta" style={{ minWidth: 0 }}><span>{s.edge.label}</span>{s.stage && s.stage !== "paper" && <span>League: {s.stage.replace("_", " ")}</span>}</span>
        <CopyBtn text={ticket(s)} />
      </div>
    </div>
  );
}

type Tab = "open" | "running" | "failed" | "won";
const TABS: { id: Tab; l: string; f: (s: RankedSetup) => boolean }[] = [
  { id: "open", l: "To enter", f: (s) => s.status === "enter" || s.status === "waiting" },
  { id: "running", l: "Running", f: (s) => s.status === "in_trade" },
  { id: "failed", l: "Failed", f: (s) => s.status === "failed" },
  { id: "won", l: "Won", f: (s) => s.status === "won" },
];

function SetupTable({ setups, now, fresh, winningOnly, setWinningOnly }: { setups: RankedSetup[]; now: number; fresh: Set<string>; winningOnly: boolean; setWinningOnly: (v: boolean) => void }) {
  const [tab, setTab] = useState<Tab>("open");
  const [all, setAll] = useState(false);
  const pool = winningOnly ? setups.filter((s) => s.edge.winning) : setups;
  const rows = pool.filter(TABS.find((t) => t.id === tab)!.f);
  const shown = all ? rows : rows.slice(0, 12);
  return (
    <div className="st">
      <div className="between" style={{ gap: 8, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="muted" style={{ fontSize: 12.5 }}>Ranked setups · today</span>
          <div className="seg" role="tablist" aria-label="Setups">
            {TABS.map((t) => { const n = pool.filter(t.f).length; return <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>{t.l}{n ? ` ${n}` : ""}</button>; })}
          </div>
        </div>
        <label className="row faint" style={{ gap: 6, fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={winningOnly} onChange={(e) => setWinningOnly(e.target.checked)} /> Winning strategies only
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="faint" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{tab === "open" ? "No setups waiting for an entry right now." : tab === "running" ? "Nothing running on paper." : tab === "failed" ? "No failed setups in the last 12 hours." : "No winners in the last 12 hours yet."}</p>
      ) : (
        <div className="st-list" role="table" aria-label="Ranked setups">
          <div className="st-row st-h" role="row"><span>#</span><span>Market</span><span>Strategy</span><span>Status</span><span>Entry</span><span>Stop</span><span>Target</span><span>Now</span><span /></div>
          {shown.map((s) => {
            const c = SETUP_CHIP[s.status];
            return (
              <div key={s.id} role="row" className={`st-row ${s.status} ${fresh.has(s.id) ? "fresh" : ""}`}>
                <span className="rk">{s.rank !== null ? `#${s.rank}` : ""}</span>
                <span className="st-m"><b>{s.symbol}</b> <Chip tone={s.side === "long" ? "up" : "down"}>{s.side === "long" ? "Long" : "Short"}</Chip></span>
                <span className="st-s"><span>{s.name}</span><EdgeBadge s={s} /></span>
                <span className="st-st"><Chip tone={c.tone} dot={s.status === "enter" || s.status === "in_trade"}>{s.status === "failed" && s.fail ? `Failed · ${s.fail === "stopped" ? "stopped" : s.fail === "expired" ? "expired" : "ran away"}` : c.l}</Chip><small className="faint">{setupLine(s, now)}</small></span>
                <span className="mono" data-l="Entry">{px(s.entry, s.digits)}</span>
                <span className="mono down" data-l="Stop">{px(s.stop, s.digits)}</span>
                <span className="mono up" data-l="Target">{px(s.target, s.digits)} <small className="faint">{num(s.rr, 1)}R</small></span>
                <span className="mono" data-l="Now">{(s.status === "waiting" || s.status === "enter") && !s.lateOk ? (s.toEntryR !== null ? `${num(s.toEntryR, 2)}R away` : "—") : s.r !== null ? <b className={s.r >= 0 ? "up" : "down"}>{signedR(s.r)}</b> : "—"}</span>
                <span className="st-c">{(s.status === "enter" || s.status === "waiting") && <CopyBtn text={ticket(s)} />}</span>
              </div>
            );
          })}
        </div>
      )}
      {rows.length > 12 && <button type="button" className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setAll((v) => !v)}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
    </div>
  );
}

function FormingRow({ f, now }: { f: Forming; now: number }) {
  const at = STAGES.indexOf(f.state as (typeof STAGES)[number]);
  const d = f.digits;
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
        {f.plan ? <><span className="mono">Entry {px(f.plan.entry, d)} · SL <span className="down">{px(f.plan.stop, d)}</span> · TP <span className="up">{px(f.plan.target, d)}</span></span>{" · "}</> : null}
        {f.blockers[0] ? `Blocked: ${f.blockers[0]}` : f.waitingFor[0] ? `Waiting for ${f.waitingFor[0]}` : f.state === "ARMED" ? "Armed: alert pending the selector" : ""}
      </span>
      <span className="faint mono" style={{ fontSize: 12 }}>{f.price !== null ? px(f.price, d) : ""} · {ago(f.at, now)}</span>
    </div>
  );
}

const RANK: Record<string, number> = { trigger: 0, in_trade: 1, armed: 2, ended: 3 };
const WIN_KEY = "cfd-desk:winning-only";

export function CfdLive() {
  const { d, error, reload } = useBoard();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [winningOnly, setWinningOnlyS] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => { try { setWinningOnlyS(localStorage.getItem(WIN_KEY) === "1"); } catch { /* no storage */ } }, []);
  const setWinningOnly = (v: boolean) => { setWinningOnlyS(v); try { localStorage.setItem(WIN_KEY, v ? "1" : "0"); } catch { /* no storage */ } };

  // A short beep the first time a setup reaches its entry (once per alert or setup, per page load).
  useEffect(() => {
    const hot = [...(d?.alerts ?? []).filter((a) => a.phase === "trigger").map((a) => a.id), ...(d?.setups ?? []).filter((s) => s.status === "enter" && (!winningOnly || s.edge.winning)).map((s) => s.id)];
    let beep = false;
    for (const id of hot) if (!seen.current.has(id)) { seen.current.add(id); beep = true; }
    if (beep && known.current) {
      try {
        const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = 880; g.gain.value = 0.05; o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.18);
      } catch { /* no audio */ }
    }
    // Setups that appeared since the last poll flash once.
    const ids = new Set((d?.setups ?? []).map((s) => s.id));
    if (known.current) setFresh(new Set([...ids].filter((x) => !known.current!.has(x))));
    if (d) known.current = ids;
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const failedAlerts = ended.filter((a) => a.outcome && FAILED.has(a.outcome)).length;
  const forming = d?.forming ?? [];
  const setups = d?.setups ?? [];
  const pool = winningOnly ? setups.filter((s) => s.edge.winning) : setups;
  const enterNow = pool.filter((s) => s.status === "enter").slice(0, 6);
  const n = (st: SetupStatus) => pool.filter((s) => s.status === st).length;
  const stale = d ? now - d.at > 30_000 : false;
  const nothing = d && live.length === 0 && forming.length === 0 && setups.length === 0;

  return (
    <section className="g12" id="cfd-desk"><div className="card s12 cl" aria-live="polite">
      <div className="between" style={{ gap: 10, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className={`led ${error || stale ? "down" : d ? "live pulse" : ""}`} />
          <h3 style={{ margin: 0, fontSize: 15 }}>CFD desk</h3>
          {(n("enter") + live.filter((a) => a.phase === "trigger").length) > 0 && <Chip tone="up">{n("enter") + live.filter((a) => a.phase === "trigger").length} to enter now</Chip>}
          {(n("waiting") + live.filter((a) => a.phase === "armed").length) > 0 && <Chip tone="warn">{n("waiting") + live.filter((a) => a.phase === "armed").length} waiting</Chip>}
          {(n("in_trade") + live.filter((a) => a.phase === "in_trade").length) > 0 && <Chip tone="info">{n("in_trade") + live.filter((a) => a.phase === "in_trade").length} running</Chip>}
          {(n("failed") + failedAlerts) > 0 && <Chip tone="down">{n("failed") + failedAlerts} failed</Chip>}
          {forming.length > 0 && <Chip>{forming.length} forming</Chip>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="faint mono" style={{ fontSize: 11.5 }}>{d ? `${timeShort(d.at, IST)} IST · live` : error ? "unavailable" : "loading…"}</span>
          <Link className="btn ghost sm" href="/arena/cfd?tab=alerts">Alerts</Link>
        </div>
      </div>
      <ErrorNote error={error || err} />
      {placed && <p className="up" style={{ fontSize: 12.5, margin: "8px 0 0", whiteSpace: "pre-line" }}>{placed}</p>}
      {nothing && <p className="muted" style={{ fontSize: 13, margin: "12px 0 0" }}>Nothing armed, forming or logged on the CFD markets today. Setups appear here as the engines find them, with entry, stop and target, ranked by how their strategy has done.</p>}

      {(() => {
        const hot = live.filter((a) => a.phase === "trigger");
        const rest = live.filter((a) => a.phase !== "trigger");
        return (
          <>
            {(hot.length > 0 || enterNow.length > 0) && (
              <>
                <div className="cl-h">Enter now</div>
                <div className="cl-grid">
                  {hot.map((a) => <AlertCard key={a.id} a={a} now={now} busy={busy} act={act} place={place} canPlace={canPlace} />)}
                  {enterNow.map((s) => <SetupCard key={s.id} s={s} now={now} fresh={fresh.has(s.id)} />)}
                </div>
              </>
            )}
            {rest.length > 0 && (
              <>
                <div className="cl-h">Confirmed A+ alerts</div>
                <div className="cl-grid">{rest.map((a) => <AlertCard key={a.id} a={a} now={now} busy={busy} act={act} place={place} canPlace={canPlace} />)}</div>
              </>
            )}
          </>
        );
      })()}

      {setups.length > 0 && <SetupTable setups={setups} now={now} fresh={fresh} winningOnly={winningOnly} setWinningOnly={setWinningOnly} />}

      {forming.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="cl-h">Forming · A+ checklist</div>
          {forming.map((f) => <FormingRow key={`${f.instrument}:${f.side}`} f={f} now={now} />)}
        </div>
      )}

      {ended.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn ghost sm" onClick={() => setShowEnded((v) => !v)}>{showEnded ? "Hide" : "Show"} ended A+ alerts ({ended.length}{failedAlerts ? `, ${failedAlerts} failed` : ""})</button>
          {showEnded && <div className="cl-grid">{ended.map((a) => <AlertCard key={a.id} a={a} now={now} busy={busy} act={act} place={place} canPlace={canPlace} />)}</div>}
        </div>
      )}
    </div></section>
  );
}
