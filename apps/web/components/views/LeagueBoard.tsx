"use client";

import { useCallback, useEffect, useState } from "react";
import { GATES_V2, isLiveStage, modelName, parseVenueKey, strategyName, type Check, type LeagueStats, type Stage, type Venue } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { staffPost } from "@/lib/market";
import { rulesFrom } from "@/lib/promotion";
import { num } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote, Toggle } from "@/components/ui";

type Cand = {
  key: string; venue: Venue | null; stage: Stage; stage_since: string; pinned: boolean; route_alerts: boolean; execute: boolean; status_reason: string | null;
  stats: { paper?: LeagueStats; recent?: LeagueStats; sinceLive?: LeagueStats; checks?: Check[] } | null;
  backtest: { trades: number; profitFactor: number | null; maxDrawdownR?: number; pass?: boolean; at?: string; days?: number } | null;
};
type Ev = { id: number; at: string; key: string; from_status: string | null; to_status: string; reason: string | null };
type Run = { id: string; at: string; status: string; trigger: string; summary: string | null; proposals: { title: string; market: string; venue: string; idea: string; why: string; test: string }[]; findings: { instrument: string; family: string; error?: string }[]; error: string | null; ms: number | null };

const STAGE: Record<Stage, { l: string; tone: "up" | "down" | "info" | "warn" | "acc" | "" }> = {
  paper: { l: "Paper", tone: "info" }, candidate: { l: "Candidate", tone: "acc" }, live_small: { l: "Live · small", tone: "up" }, live: { l: "Live", tone: "up" }, benched: { l: "Benched", tone: "down" }, retired: { l: "Retired", tone: "" },
};
const VENUE: Record<Venue, string> = { cfd: "CFD", delta: "Delta", coinswitch: "CoinSwitch", fyers: "Fyers" };
const ORDER: Stage[] = ["live", "live_small", "candidate", "paper", "benched"];
const nameOf = (key: string) => { const p = parseVenueKey(key); return p ? (p.model === "S" ? strategyName(p.strategy) : modelName(p.model)) : key; };
const r2 = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : num(x, d));

export default function LeagueBoard() {
  const me = useMe();
  const [cands, setCands] = useState<Cand[] | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [venue, setVenue] = useState<Venue | "all">("all");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rules = rulesFrom(me.settings?.integrations?.promotion);

  const load = useCallback(async () => {
    const [c, e, r] = await Promise.all([
      supabase.from("strategy_candidates").select("key, venue, stage, stage_since, pinned, route_alerts, execute, status_reason, stats, backtest").not("venue", "is", null).neq("stage", "retired"),
      supabase.from("candidate_events").select("id, at, key, from_status, to_status, reason").like("key", "%/%").order("at", { ascending: false }).limit(25),
      supabase.from("strategy_agent_runs").select("*").order("at", { ascending: false }).limit(10),
    ]);
    if (c.error) return setErr(/stage|venue|strategy_agent_runs/.test(c.error.message) ? "Apply migration 20261101120000_league_v2.sql to start the v2 League." : c.error.message);
    setErr(null);
    setCands((c.data ?? []) as Cand[]);
    setEvents((e.data ?? []) as Ev[]);
    setRuns((r.data ?? []) as Run[]);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const patch = async (c: Cand, p: Partial<Cand>) => {
    const r = await supabase.from("strategy_candidates").update({ ...p, updated_at: new Date().toISOString() }).eq("key", c.key);
    setMsg(r.error ? r.error.message : "Saved");
    load();
  };
  const setRule = async (k: "enabled" | "autoPromote" | "autoDemote", v: boolean) => {
    const e = await me.updateSettings({ integrations: { ...(me.settings?.integrations ?? { telegram_chats: [], ai_model: null }), promotion: { ...rules, [k]: v } } });
    setMsg(e ?? "Saved: applies on the next pass");
  };
  const [chats, setChats] = useState("");
  useEffect(() => setChats((me.settings?.integrations?.live_chats ?? []).map((c) => `${c.id}${c.label && c.label !== c.id ? `:${c.label}` : ""}`).join("\n")), [me.settings]);
  const saveChats = async () => {
    const list = chats.split(/\n|,/).map((x) => x.trim()).filter(Boolean).map((x) => { const [id, ...rest] = x.split(":"); return { id: id!.trim(), label: rest.join(":").trim() || id!.trim() }; });
    const e = await me.updateSettings({ integrations: { ...(me.settings?.integrations ?? { telegram_chats: [], ai_model: null }), live_chats: list } });
    setMsg(e ?? (list.length ? `Live alerts go to ${list.length} chat${list.length > 1 ? "s" : ""}` : "Live alerts go to the firm's alert chats"));
  };
  const runAgent = async () => {
    setBusy(true); setMsg("The agent is running backtests. This takes a few minutes.");
    try { const r = await staffPost<{ summary: string }>("/api/league/agent", {}); setMsg(r.summary); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); load(); }
  };

  const all = (cands ?? []).filter((c) => venue === "all" || c.venue === venue);
  const counts = ORDER.map((s) => ({ s, n: all.filter((c) => c.stage === s).length }));
  const sorted = [...all].sort((a, b) => ORDER.indexOf(a.stage) - ORDER.indexOf(b.stage) || (b.stats?.paper?.score ?? 0) - (a.stats?.paper?.score ?? 0));
  const last = runs[0];

  return (
    <>
      <ErrorNote error={err} />
      {msg && <div className="banner info">{msg}</div>}
      <section className="g12">
        <Card span={12} title="Pipeline" right={<span className="faint" style={{ fontSize: 12.5 }}>Every strategy paper-trades on every venue that can run it, with that venue's costs</span>}>
          <div className="g12" style={{ gap: 10 }}>
            {counts.map(({ s, n }) => (
              <div key={s} className="s2" style={{ padding: 14, borderRadius: 12, background: "var(--surface-2)" }}>
                <div className="muted" style={{ fontSize: 12.5 }}>{STAGE[s].l}</div>
                <div className="kv">{n}</div>
              </div>
            ))}
            <div className="s2" style={{ padding: 14, borderRadius: 12, background: "var(--surface-2)" }}>
              <div className="muted" style={{ fontSize: 12.5 }}>Gates</div>
              <div className="kv">v{GATES_V2.version}</div>
            </div>
          </div>
        </Card>

        <Card span={8} title="Standings" right={<div className="seg" role="group" aria-label="Venue">{(["all", "cfd", "delta", "coinswitch", "fyers"] as const).map((v) => <button key={v} type="button" className={venue === v ? "on" : ""} onClick={() => setVenue(v)}>{v === "all" ? "All" : VENUE[v]}</button>)}</div>}>
          {cands === null ? <Empty>Loading…</Empty> : sorted.length === 0 ? <Empty>No records since the restart yet. Every setup the engine logs from now on counts here.</Empty> : (
            <div className="tbl-w"><table className="tbl">
              <thead><tr><th>Strategy</th><th>Stage</th><th className="r">Trades</th><th className="r">Per trade</th><th className="r">PF</th><th className="r">90% floor</th><th>Gates</th><th>Backtest</th><th>Pin</th>{venue === "delta" || venue === "all" ? <th>Orders</th> : null}</tr></thead>
              <tbody>
                {sorted.map((c) => {
                  const p = c.stats?.paper, checks = c.stats?.checks ?? [], k = parseVenueKey(c.key);
                  return (
                    <tr key={c.key} title={c.status_reason ?? undefined}>
                      <td><b style={{ fontWeight: 500 }}>{nameOf(c.key)}</b><div className="faint" style={{ fontSize: 12 }}>{k?.instrument} · {c.venue ? VENUE[c.venue] : "—"}</div></td>
                      <td><Chip tone={STAGE[c.stage].tone}>{STAGE[c.stage].l}</Chip></td>
                      <td className="r mono">{p?.n ?? 0}</td>
                      <td className={`r mono ${(p?.expectancy ?? 0) >= 0 ? "up" : "down"}`}>{p ? `${p.expectancy >= 0 ? "+" : ""}${r2(p.expectancy)}R` : "—"}</td>
                      <td className="r mono">{p?.profitFactor === null ? "∞" : r2(p?.profitFactor)}</td>
                      <td className={`r mono ${(p?.lowerBound ?? -1) > 0 ? "up" : "faint"}`}>{r2(p?.lowerBound)}</td>
                      <td title={checks.map((x) => `${x.ok ? "✓" : "✗"} ${x.label}: ${x.value}`).join("\n")}><span className="mono">{checks.filter((x) => x.ok).length}/{checks.length || 6}</span></td>
                      <td className="mono" style={{ fontSize: 12 }}>{c.backtest ? <span className={c.backtest.pass ? "up" : "faint"}>{c.backtest.trades} · PF {c.backtest.profitFactor ?? "∞"}</span> : <span className="faint">—</span>}</td>
                      <td><Toggle on={c.pinned} label={`Pin ${c.key}`} onChange={(v) => patch(c, { pinned: v })} /></td>
                      {venue === "delta" || venue === "all" ? <td>{c.venue === "delta" ? <Toggle on={c.execute} label={`Delta orders for ${c.key}`} onChange={(v) => patch(c, { execute: v })} /> : null}</td> : null}
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
          <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>Hover a row for its gate checks. Pinned strategies never move. "Orders" lets a live Delta strategy place orders through the Delta risk gate; elsewhere live means live alerts.</p>
        </Card>

        <div className="s4 col" style={{ gap: 16 }}>
          <Card title="Strategy agent" right={<button className="btn sm pri" disabled={busy} onClick={runAgent}>{busy ? "Running…" : "Run now"}</button>}>
            {!last ? <Empty>Runs daily at 06:37 IST once migration 20261101120000 is applied.</Empty> : (
              <>
                <div className="between" style={{ fontSize: 12.5, marginBottom: 8 }}><span className="faint">{new Date(last.at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} IST · {last.trigger}</span><Chip tone={last.status === "done" ? "up" : last.status === "failed" ? "down" : "warn"}>{last.status}</Chip></div>
                <p style={{ fontSize: 13, color: "var(--muted)" }}>{last.error ?? last.summary ?? "…"}</p>
                {last.findings.length > 0 && <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>Backtested: {last.findings.map((f) => `${f.instrument} ${f.family}${f.error ? " (failed)" : ""}`).join(", ")}</p>}
              </>
            )}
          </Card>
          <Card title="Ideas to review">
            {runs.flatMap((r) => r.proposals.map((p) => ({ ...p, at: r.at }))).slice(0, 6).map((p, i) => (
              <div key={i} style={{ padding: "10px 0", borderTop: i ? "1px solid var(--line)" : 0 }}>
                <b style={{ fontWeight: 500, fontSize: 13 }}>{p.title}</b> <span className="faint" style={{ fontSize: 12 }}>· {p.market} {p.venue}</span>
                <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{p.idea}</p>
                {p.test && <p className="faint" style={{ fontSize: 12, marginTop: 4 }}>Test: {p.test}</p>}
              </div>
            ))}
            {!runs.some((r) => r.proposals.length) && <Empty>The agent's proposals land here. They are never deployed without you.</Empty>}
          </Card>
          <Card title="Live alert chats">
            <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>New signals of live strategies go here. Empty means the firm's alert chats. One per line as id:label.</p>
            <textarea className="inp" aria-label="Live alert chats" value={chats} onChange={(e) => setChats(e.target.value)} placeholder="-1001234567890:Live desk" />
            <button className="btn sm" style={{ marginTop: 8 }} onClick={saveChats}>Save chats</button>
          </Card>
          <Card title="Gates v2.0" right={<Chip>fixed</Chip>}>
            {[
              ["Paper trades", `${GATES_V2.paper.minTrades}+ over ${GATES_V2.paper.minDays}+ days`],
              ["Expectancy", `≥ ${GATES_V2.paper.minExpectancy}R, and above zero at 90%`],
              ["Profit factor", `≥ ${GATES_V2.paper.minProfitFactor}`],
              ["Drawdown", `≤ ${GATES_V2.paper.maxDrawdownR}R`],
              ["Backtest (when run)", `${GATES_V2.backtest.minTrades}+ trades, PF ≥ ${GATES_V2.backtest.minProfitFactor}`],
              ["Live slots", `${GATES_V2.slotsPerMarket} per venue and market; small size first`],
              ["Full size after", `${GATES_V2.liveSmall.minTrades} live trades ≥ ${GATES_V2.liveSmall.minExpectancy}R`],
              ["Benched when", `last ${GATES_V2.demote.lastN} trades below zero, or drawdown past ${GATES_V2.demote.drawdownMultiple}× the backtest's`],
            ].map(([k, v]) => <div key={k} className="between" style={{ padding: "7px 0", borderTop: "1px solid var(--line)", fontSize: 12.5 }}><span className="muted">{k}</span><span style={{ textAlign: "right" }}>{v}</span></div>)}
            <div className="col" style={{ gap: 8, marginTop: 12 }}>
              {([["enabled", "League moves on"], ["autoPromote", "Promote automatically"], ["autoDemote", "Bench automatically"]] as const).map(([k, l]) => (
                <div key={k} className="between" style={{ fontSize: 13 }}><span>{l}</span><Toggle on={rules[k]} label={l} onChange={(v) => setRule(k, v)} /></div>
              ))}
            </div>
          </Card>
        </div>

        <Card span={12} title="Recent moves">
          {events.length === 0 ? <Empty>No moves yet</Empty> : events.map((e) => (
            <div key={e.id} style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1.2fr) 200px minmax(0,2fr)", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13, alignItems: "center" }}>
              <span className="mono faint" style={{ fontSize: 12 }}>{new Date(e.at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
              <span>{nameOf(e.key)} <span className="faint">· {parseVenueKey(e.key)?.instrument} {parseVenueKey(e.key) ? VENUE[parseVenueKey(e.key)!.venue] : ""}</span></span>
              <span>{STAGE[(e.from_status ?? "paper") as Stage]?.l ?? e.from_status} → <b style={{ fontWeight: 500, color: isLiveStage(e.to_status as Stage) ? "var(--up)" : e.to_status === "benched" ? "var(--down)" : undefined }}>{STAGE[e.to_status as Stage]?.l ?? e.to_status}</b></span>
              <span className="muted" style={{ fontSize: 12.5 }}>{e.reason}</span>
            </div>
          ))}
        </Card>
      </section>
    </>
  );
}
