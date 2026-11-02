"use client";

import { useEffect, useState } from "react";
import { PROP_PRESETS, propRoom, type PropRules } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { staffGet, staffPost } from "@/lib/market";
import { useRows } from "@/lib/useRows";
import { arenaOf } from "@/lib/arenas";
import { money, num } from "@/lib/fmt";
import { rulesOf, stateOf, type ClosedTrade, type PropAccount } from "@/lib/propAccounts";
import { Card, Chip, Empty, ErrorNote } from "@/components/ui";
import Challenges from "@/components/views/Challenges";

type Account = PropAccount & { venue: string; platform: string | null; type: string };

function Gauge({ label, value, max, tone, foot }: { label: string; value: number; max: number; tone: "" | "warn" | "info" | "down"; foot: string }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <span className="muted" style={{ fontSize: 12.5 }}>{label}</span>
      <div className={`bar ${tone}`}><i style={{ width: `${Math.max(0, Math.min(100, (value / Math.max(max, 1e-9)) * 100))}%` }} /></div>
      <span className="mono" style={{ fontSize: 12.5 }}>{foot}</span>
    </div>
  );
}

function RulesForm({ a, onSaved }: { a: Account; onSaved: () => void }) {
  const fr = a.firm_rules ?? {};
  const [preset, setPreset] = useState(fr.preset ?? "");
  const [phase, setPhase] = useState(fr.phase ?? 0);
  const [risk, setRisk] = useState(String(fr.risk_pct ?? 0.5));
  const [reset, setReset] = useState(String(fr.day_reset_utc ?? 0));
  const [msg, setMsg] = useState<string | null>(null);
  const phases = preset ? PROP_PRESETS[preset]?.phases ?? [] : [];
  const save = async () => {
    const riskPct = Number(risk), resetH = Number(reset);
    if (!(riskPct > 0 && riskPct <= 2)) return setMsg("Risk per alert must be between 0 and 2%");
    if (!(Number.isInteger(resetH) && resetH >= 0 && resetH <= 23)) return setMsg("Day reset is an hour from 0 to 23 (UTC)");
    const { error } = await supabase.from("trading_accounts").update({ firm_rules: { ...fr, preset: preset || undefined, phase, risk_pct: riskPct, day_reset_utc: resetH } }).eq("id", a.id);
    setMsg(error ? error.message : "Saved");
    if (!error) onSaved();
  };
  return (
    <div className="g12" style={{ gap: 10, alignItems: "end" }}>
      <label className="fld s4"><span>Firm rules</span><div className="inp txt"><select value={preset} onChange={(e) => { setPreset(e.target.value); setPhase(0); }}>
        <option value="">Not a prop account</option>
        {Object.values(PROP_PRESETS).map((p) => <option key={p.preset} value={p.preset}>{p.firm} · {p.plan}</option>)}
      </select></div></label>
      <label className="fld s3"><span>Stage</span><div className="inp txt"><select value={phase} onChange={(e) => setPhase(Number(e.target.value))} disabled={!phases.length}>{phases.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}</select></div></label>
      <label className="fld s2"><span>Risk per alert</span><div className="inp"><input value={risk} onChange={(e) => setRisk(e.target.value)} inputMode="decimal" /><span className="u">%</span></div></label>
      <label className="fld s2"><span>Day reset</span><div className="inp"><input value={reset} onChange={(e) => setReset(e.target.value)} inputMode="numeric" /><span className="u">UTC</span></div></label>
      <button className="btn pri sm s1" onClick={save}>Save</button>
      {msg && <p className={msg === "Saved" ? "up" : "down"} style={{ fontSize: 12.5, gridColumn: "1 / -1" }}>{msg}</p>}
    </div>
  );
}

function ruleRows(r: PropRules): [string, string][] {
  return [
    ["Profit target", r.phases.map((p) => `${p.name} ${p.targetPct ? `${p.targetPct}%` : "—"}`).join(" · ")],
    ["Daily loss", `${r.dailyLossPct}% ${r.dailyBasis === "start_balance" ? "of the starting balance, static" : "of the higher of end-of-day equity or balance"}`],
    ["Max loss", `${r.maxLossPct}% ${r.maxLossType}`],
    ["Per-trade loss", r.perTradeLossPct === null ? "No limit" : `${r.perTradeLossPct}%`],
    ["Profitable days", r.minProfitableDays === null ? "Not required" : `${r.minProfitableDays} needed`],
    ["Consistency", r.consistencyShare === null ? "None" : `No day over ${r.consistencyShare * 100}% of profit`],
    ["News · weekends", `${r.newsAllowed ? "News allowed" : "No news trading"} · ${r.weekendHolding ? "weekend holding allowed" : "close before the weekend"}`],
    ["Leverage", r.leverage],
  ];
}

/** Challenge tab: each prop account's room left under its firm's rules, and the rule settings. */
export function ChallengeTab() {
  const accounts = useRows<Account>({ table: "trading_accounts", select: "id,name,currency,start_balance,balance,equity,active,instruments,firm_rules,venue,platform,type", order: "created_at", ascending: true });
  const trades = useRows<ClosedTrade>({ table: "trades", select: "account_id,pnl,closed_at", notNull: "closed_at", order: "closed_at", limit: 5000 });
  const [edit, setEdit] = useState<string | null>(null);
  const cfd = (accounts.rows ?? []).filter((a) => a.active && arenaOf(a) === "cfd");
  return (
    <>
      <ErrorNote error={accounts.error || trades.error} />
      {cfd.length === 0 && <Empty>Add your FundedHive and The5ers accounts under Accounts, then set their firm rules here.</Empty>}
      <section className="g12">
        {cfd.map((a) => {
          const r = rulesOf(a);
          if (!r) return (
            <Card key={a.id} span={6} title={a.name} right={<Chip>No firm rules</Chip>}>
              <p className="muted" style={{ marginBottom: 12 }}>Pick the firm's rules so alerts are sized to this account and the gauges below appear.</p>
              <RulesForm a={a} onSaved={accounts.reload} />
            </Card>
          );
          const st = stateOf(a, trades.rows ?? []);
          const room = propRoom(r, st);
          return (
            <Card key={a.id} span={6} title={a.name} right={<><Chip tone={room.breached.length ? "down" : room.passed ? "up" : "warn"}>{room.breached.length ? `Breached: ${room.breached.join(", ")}` : room.passed ? `${room.phaseName} passed` : room.phaseName}</Chip><button className="btn ghost sm" onClick={() => setEdit(edit === a.id ? null : a.id)}>Rules</button></>}>
              <p className="faint" style={{ fontSize: 12.5, marginTop: -6, marginBottom: 12 }}>{r.firm} · {r.plan}</p>
              <div className="between" style={{ alignItems: "baseline", marginBottom: 14 }}>
                <span className="kv">{money(st.equity, a.currency, 0)}</span>
                <span className={`mono ${room.progress >= 0 ? "up" : "down"}`}>{room.progress >= 0 ? "+" : ""}{money(room.progress, a.currency, 0)}</span>
              </div>
              <div className="g12" style={{ gap: 14 }}>
                <div className="s4"><Gauge label="Target" value={room.progress} max={room.target} tone="" foot={room.target ? `${money(room.targetLeft, a.currency, 0)} to go` : "Funded"} /></div>
                <div className="s4"><Gauge label="Daily loss room" value={room.dailyRoom} max={room.dailyLimit} tone={room.dailyRoom < room.dailyLimit * 0.3 ? "down" : "warn"} foot={`${money(room.dailyRoom, a.currency, 0)} of ${money(room.dailyLimit, a.currency, 0)}`} /></div>
                <div className="s4"><Gauge label="Max-loss room" value={room.maxRoom} max={st.startBalance - room.maxFloor + Math.max(0, st.equity - st.startBalance)} tone="info" foot={`${money(room.maxRoom, a.currency, 0)} · floor ${money(room.maxFloor, a.currency, 0)}`} /></div>
              </div>
              <div className="g12" style={{ gap: 14, marginTop: 14 }}>
                <div className="s4 stat"><div className="k">Per-trade cap</div><div className="v" style={{ fontSize: 16 }}>{room.perTradeCap === null ? "None" : money(room.perTradeCap, a.currency, 0)}</div></div>
                <div className="s4 stat"><div className="k">Profitable days</div><div className="v" style={{ fontSize: 16 }}>{room.profitableDays}{room.daysNeeded ? ` of ${room.daysNeeded}` : ""}</div></div>
                <div className="s4 stat"><div className="k">Risk per alert</div><div className="v" style={{ fontSize: 16 }}>{num(a.firm_rules?.risk_pct ?? 0.5, 2)}%</div></div>
              </div>
              {edit === a.id ? <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line)" }}><RulesForm a={a} onSaved={() => { setEdit(null); accounts.reload(); }} /></div> : (
                <div style={{ marginTop: 14 }}>
                  {ruleRows(r).map(([k, v]) => <div key={k} className="between" style={{ padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}><span className="muted">{k}</span><span style={{ textAlign: "right" }}>{v}</span></div>)}
                  <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>Daily figures reset at {a.firm_rules?.day_reset_utc ?? 0}:00 UTC. Check this against the firm's server time.</p>
                </div>
              )}
            </Card>
          );
        })}
      </section>
      <h3 style={{ fontSize: 14, marginTop: 8 }}>Purchases and copy rules</h3>
      <Challenges />
    </>
  );
}

type Leg = { id: string; account_id: string; lots: number; legs: number[]; risk_amount: number; bound_by: string; blocked: string | null; link: string | null; action: string | null; action_by: string | null; trading_accounts: { name: string } | null };
type Alert = { id: string; symbol: string; side: "long" | "short"; model: string | null; grade: string | null; entry: number; stop: number; tp1: number; tp2: number; expires_at: string; status: string; why: string[]; created_at: string; cfd_alert_legs: Leg[] };

type CtPos = { id: number; symbol: string; side: "long" | "short"; units: number; entry: number; sl: number | null; tp: number | null; comment: string | null; openedAt: number };
type CtAcc = { ctid: number; login: number | null; isLive: boolean; balance: number | null; positions: CtPos[]; syncedAt: number | null; error: string | null; accountId: string | null; name: string | null };
type CtSnap = { connected: boolean; reason?: string; configured?: boolean; signedIn?: boolean; error?: string | null; accounts?: CtAcc[] };

/** What is actually open on the prop accounts, read from cTrader (read-only). */
function CTraderPositions() {
  const [snap, setSnap] = useState<CtSnap | null>(null);
  useEffect(() => {
    const load = () => staffGet<CtSnap>("/api/cfd/positions").then(setSnap, (e: Error) => setSnap({ connected: false, reason: e.message }));
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);
  const accs = snap?.accounts ?? [];
  return (
    <Card title="Open on cTrader" right={<Chip tone={snap?.connected && snap.signedIn ? "up" : ""} dot>{!snap ? "…" : !snap.connected ? "Not connected" : !snap.configured ? "Not set up" : !snap.signedIn ? "Sign in needed" : "Read-only sync"}</Chip>}>
      {!snap?.connected || !snap.signedIn ? (
        <p className="muted" style={{ fontSize: 13 }}>{snap?.reason ?? "Connect cTrader under Integrations to see the positions you placed from alerts, with live balances. The sync is read-only."}</p>
      ) : accs.length === 0 ? <Empty>No cTrader accounts on this sign-in</Empty> : accs.map((a) => (
        <div key={a.ctid} style={{ padding: "10px 0", borderTop: "1px solid var(--line)" }}>
          <div className="between" style={{ fontSize: 13 }}>
            <b style={{ fontWeight: 500 }}>{a.name ?? `Login ${a.login ?? a.ctid}`}{!a.accountId && <span className="faint" style={{ fontWeight: 400 }}> · not linked</span>}</b>
            <span className="mono">{a.balance === null ? "—" : money(a.balance, "USD", 0)}</span>
          </div>
          {a.error && <p className="down" style={{ fontSize: 12 }}>{a.error}</p>}
          {a.positions.length === 0 ? <p className="faint" style={{ fontSize: 12.5 }}>No open positions</p> : a.positions.map((p) => (
            <div key={p.id} className="between mono" style={{ fontSize: 12, padding: "4px 0" }}>
              <span className={p.side === "long" ? "up" : "down"}>{p.side === "long" ? "Buy" : "Sell"} {p.symbol}</span>
              <span>{num(p.units, p.units < 10 ? 2 : 0)} @ {num(p.entry, p.entry > 100 ? 2 : 5)}</span>
              <span className="faint">{p.comment?.startsWith("APLUS") ? "from alert" : "manual"}</span>
            </div>
          ))}
        </div>
      ))}
      <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>Accounts link by login number: put each cTrader login in the account's broker account field.</p>
    </Card>
  );
}

/** Alerts tab: every armed setup with its size per account, cTrader links and Taken / Skip. */
export function AlertsTab() {
  const alerts = useRows<Alert>({ table: "cfd_alerts", select: "*, cfd_alert_legs(*, trading_accounts(name))", order: "created_at", limit: 30 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState({ instrument: "XAUUSD", side: "long" as "long" | "short", entry: "", stop: "", target: "" });
  const act = async (alertId: string, action: "taken" | "skipped", accountId?: string) => {
    setBusy(alertId + (accountId ?? "")); setErr(null);
    try { await staffPost("/api/cfd/alerts", { action, alertId, accountId }); alerts.reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const sendTest = async () => {
    setErr(null); setBusy("test");
    try {
      await staffPost("/api/cfd/alerts", { action: "test", instrument: test.instrument, side: test.side, entry: Number(test.entry), stop: Number(test.stop), target: Number(test.target) });
      alerts.reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const digits = (s: string) => (s.endsWith("JPY") ? 3 : s.length === 6 && !s.startsWith("XAU") && !s.startsWith("BTC") ? 5 : 2);
  return (
    <>
      <ErrorNote error={alerts.error || err} />
      <section className="g12">
        <div className="s8 col" style={{ gap: 16 }}>
          {(alerts.rows ?? []).length === 0 && <Card><Empty>No alerts yet. The engine sends one when an A+ setup arms on a CFD market.</Empty></Card>}
          {(alerts.rows ?? []).map((a) => {
            const live = a.status === "armed" && Date.parse(a.expires_at) > Date.now();
            const d = digits(a.symbol);
            return (
              <Card key={a.id} title={<span className="row" style={{ gap: 8 }}>{a.grade && <span className="chip solid">{a.grade}</span>}{a.symbol} {a.side === "long" ? "long" : "short"}{a.model ? ` · Model ${a.model}` : ""}</span>}
                right={<><span className="faint" style={{ fontSize: 12 }}>{new Date(a.created_at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} IST</span><Chip tone={a.status === "taken" ? "up" : a.status === "skipped" ? "" : live ? "warn" : ""}>{live ? "Armed" : a.status === "armed" ? "Expired" : a.status === "taken" ? "Taken" : "Skipped"}</Chip></>}>
                <div className="px" style={{ marginBottom: 12 }}>
                  {[["Entry · limit", a.entry, ""], ["Stop", a.stop, "down"], ["TP1", a.tp1, "up"], ["TP2", a.tp2, "up"]].map(([k, v, t]) => <div key={k as string}><span className="lbl">{k}</span><b className={`mono ${t}`}>{num(Number(v), d)}</b></div>)}
                </div>
                {a.cfd_alert_legs.map((l) => (
                  <div key={l.id} className="between" style={{ padding: "9px 0", borderTop: "1px solid var(--line)", fontSize: 13, gap: 12, flexWrap: "wrap" }}>
                    <span><b style={{ fontWeight: 500 }}>{l.trading_accounts?.name ?? "Account"}</b> {l.blocked ? <span className="down">· {l.blocked}</span> : <span className="muted">· {num(Number(l.lots), 2)} lots{l.legs.length === 2 ? ` (${num(Number(l.legs[0]), 2)} + ${num(Number(l.legs[1]), 2)})` : ""} · risk ${num(Number(l.risk_amount), 0)}{l.bound_by !== "risk" ? ` · capped by ${l.bound_by}` : ""}</span>}</span>
                    <span className="row" style={{ gap: 6 }}>
                      {l.action ? <Chip tone={l.action === "taken" ? "up" : ""}>{l.action}{l.action_by ? ` · ${l.action_by}` : ""}</Chip> : null}
                      {l.link && <a className="btn sm" href={l.link} target="_blank" rel="noopener noreferrer">Open in cTrader</a>}
                      {live && !l.blocked && !l.action && <button className="btn ghost sm" disabled={busy !== null} onClick={() => act(a.id, "taken", l.account_id)}>Taken</button>}
                    </span>
                  </div>
                ))}
                {live && <div className="row" style={{ marginTop: 12 }}><button className="btn pri sm" disabled={busy !== null} onClick={() => act(a.id, "taken")}>Taken on all</button><button className="btn sm" disabled={busy !== null} onClick={() => act(a.id, "skipped")}>Skip</button></div>}
                {a.why.length > 0 && <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>{a.why.slice(0, 3).join(" · ")}</p>}
              </Card>
            );
          })}
        </div>
        <div className="s4 col" style={{ gap: 16 }}>
          <CTraderPositions />
          <Card title="How alerts work">
            <p className="muted" style={{ fontSize: 13 }}>When an A+ setup arms on a CFD market, each prop account gets its own size under its firm's rules. The Telegram alert has one <b>Open in cTrader</b> button per account that opens cTrader's order screen already filled in: limit entry, stop, TP1 and TP2 with that account's volume. Check it, place it, then tap <b>Taken</b>.</p>
            <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>Taken / Skip in Telegram needs the bot webhook: set TELEGRAM_WEBHOOK_SECRET in Vercel, then register it from Integrations.</p>
          </Card>
          <Card title="Send a test alert">
            <div className="col" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 8 }}>
                <div className="inp txt" style={{ flex: 1 }}><select aria-label="Market" value={test.instrument} onChange={(e) => setTest({ ...test, instrument: e.target.value })}>{["XAUUSD", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY", "SPX500", "NAS100"].map((s) => <option key={s} value={s}>{s === "SPX500" ? "US500" : s}</option>)}</select></div>
                <div className="seg">{(["long", "short"] as const).map((s) => <button key={s} type="button" className={test.side === s ? "on" : ""} onClick={() => setTest({ ...test, side: s })}>{s === "long" ? "Long" : "Short"}</button>)}</div>
              </div>
              {(["entry", "stop", "target"] as const).map((k) => (
                <label key={k} className="fld"><span>{k === "entry" ? "Entry (limit)" : k === "stop" ? "Stop" : "Final target"}</span><div className="inp"><input inputMode="decimal" value={test[k]} onChange={(e) => setTest({ ...test, [k]: e.target.value })} /></div></label>
              ))}
              <button className="btn pri" disabled={busy !== null || !test.entry || !test.stop || !test.target} onClick={sendTest}>{busy === "test" ? "Sending…" : "Send test alert to Telegram"}</button>
              <p className="faint" style={{ fontSize: 12 }}>Goes through the full path: rules, sizing, links and buttons. It is labelled as a test.</p>
            </div>
          </Card>
        </div>
      </section>
    </>
  );
}
