"use client";

import { useCallback, useEffect, useState } from "react";
import { modelName, strategyName } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useMe } from "@/components/Shell";
import { DEFAULT_RULES, promotionChecks, rulesFrom, type CandidateStats, type PromotionRules } from "@/lib/promotion";
import { r as fmtR, pct } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Kpi, Note, Toggle } from "@/components/ui";

/**
 * Live strategies: candidates promoted from the never-ending paper run. Paper keeps scoring every
 * market × model; this page shows what is live, what is ready or close, what was benched and why,
 * and the rules that decide it. Live signals go to the live alert chats.
 */

type Stats = { window: CandidateStats; recent: CandidateStats; live: CandidateStats; allTime: CandidateStats; ready: boolean };
interface Cand {
  key: string; instrument: string; model: string; strategy: string | null; status: "paper" | "live" | "benched"; pinned: boolean; route_alerts: boolean;
  stats: Partial<Stats>; live_since: string | null; benched_at: string | null; status_reason: string | null; updated_at: string;
}
interface Ev { id: number; at: string; key: string; from_status: string | null; to_status: string; reason: string | null }

const name = (c: Pick<Cand, "model" | "strategy">) => (c.model === "S" ? strategyName(c.strategy ?? undefined) : modelName(c.model));
const days = (iso: string | null) => (iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 86_400_000) : 0);
const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "");
const EMPTY: CandidateStats = { n: 0, wins: 0, winRate: 0, netR: 0, expectancy: 0, profitFactor: 0, maxDrawdownR: 0, last10R: 0, avgCostR: 0, score: 0, firstAt: null, lastAt: null };
const st = (c: Cand, k: keyof Stats) => (c.stats[k] as CandidateStats | undefined) ?? EMPTY;

function StatLine({ s, label }: { s: CandidateStats; label: string }) {
  return (
    <div className="between faint mono" style={{ fontSize: 11 }}>
      <span>{label}</span>
      <span><span className={tone(s.netR)}>{fmtR(s.netR)}</span> · {s.n} tr · {pct(s.winRate, 0)} · PF {s.profitFactor === null ? "∞" : s.profitFactor} · DD {s.maxDrawdownR}R</span>
    </div>
  );
}

export default function LivePage() {
  const me = useMe();
  const [cands, setCands] = useState<Cand[] | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const rules = rulesFrom(me.settings?.integrations?.promotion);
  const [form, setForm] = useState<PromotionRules>(rules);
  const [chats, setChats] = useState("");

  const load = useCallback(async () => {
    const [c, e] = await Promise.all([
      supabase.from("strategy_candidates").select("*").order("updated_at", { ascending: false }),
      supabase.from("candidate_events").select("id, at, key, from_status, to_status, reason").order("at", { ascending: false }).limit(30),
    ]);
    if (c.error) return setError(c.error.message);
    setError(null);
    setCands((c.data ?? []) as Cand[]);
    setEvents((e.data ?? []) as Ev[]);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { setForm(rulesFrom(me.settings?.integrations?.promotion)); setChats((me.settings?.integrations?.live_chats ?? []).map((c) => `${c.id}${c.label && c.label !== c.id ? `:${c.label}` : ""}`).join("\n")); }, [me.settings]);

  const act = async (c: Cand, patch: Partial<Cand>, to?: Cand["status"], reason?: string) => {
    const now = new Date().toISOString();
    const r = await supabase.from("strategy_candidates").update({
      ...patch, updated_at: now,
      ...(to ? { status: to, status_reason: reason ?? null, ...(to === "live" ? { live_since: now, benched_at: null } : to === "benched" ? { benched_at: now } : {}) } : {}),
    }).eq("key", c.key);
    if (!r.error && to) await supabase.from("candidate_events").insert({ key: c.key, from_status: c.status, to_status: to, reason, stats: c.stats, by_user: me.session.user.id });
    setMsg(r.error ? r.error.message : "Saved");
    load();
  };
  const saveRules = async () => {
    const err = await me.updateSettings({ integrations: { ...(me.settings?.integrations ?? { telegram_chats: [], ai_model: null }), promotion: form } });
    setMsg(err ?? "Rules saved: applied on the next autopilot pass");
  };
  const saveChats = async () => {
    const list = chats.split(/\n|,/).map((s) => s.trim()).filter(Boolean).map((s) => { const [id, ...rest] = s.split(":"); return { id: id!.trim(), label: rest.join(":").trim() || id!.trim() }; });
    const err = await me.updateSettings({ integrations: { ...(me.settings?.integrations ?? { telegram_chats: [], ai_model: null }), live_chats: list } });
    setMsg(err ?? (list.length ? `Live alerts go to ${list.length} chat${list.length > 1 ? "s" : ""}` : "Live alerts go to the firm's alert chats"));
  };

  const all = cands ?? [];
  const live = all.filter((c) => c.status === "live");
  const benched = all.filter((c) => c.status === "benched");
  const waiting = all.filter((c) => c.status !== "live").sort((a, b) => st(b, "window").score - st(a, "window").score);
  const ready = waiting.filter((c) => c.stats.ready);
  const liveNet = live.reduce((s, c) => s + st(c, "live").netR, 0);
  const missing = error && /strategy_candidates/.test(error);

  return (
    <>
      {missing ? <Note tone="warn">The promotion tables are not in the database yet: apply migration 20261028110000_strategy_promotion.sql.</Note> : <ErrorNote error={error} />}
      {msg && <Note tone="up">{msg}</Note>}
      <section className="card" style={{ padding: 14, fontSize: 13 }}>
        <b>Paper never stops.</b> Every market × entry model (and each session strategy) is paper traded and scored on its last {rules.windowDays} days in net R after costs.
        Clear the rules and it is <b>promoted to live</b>: its new signals go to the live alert chats. When its record decays it is <b>benched</b> and the best waiting candidate takes the slot.
        <span className="faint"> Live means live alerts and a live-era record. Orders are still placed by hand; broker execution is not wired yet.</span>
      </section>

      <section className="g12">
        <Kpi label="Live strategies" value={`${live.length} / ${rules.maxLive}`} foot={<span className="faint">{rules.enabled ? (rules.autoPromote ? "auto-promote on" : "manual promotion") : "promotion off"}</span>} />
        <Kpi label="Live-era result" value={fmtR(liveNet)} tone={tone(liveNet)} foot={<span className="faint">{live.reduce((s, c) => s + st(c, "live").n, 0)} resolved since promotion</span>} />
        <Kpi label="Ready to promote" value={ready.length} tone={ready.length ? "up" : ""} foot={<span className="faint">clear every rule now</span>} />
        <Kpi label="Candidates scored" value={all.length} foot={<span className="faint">{benched.length} benched · updated each pass</span>} />
      </section>

      <Card title="Live" right={<Chip tone="down" dot>live alerts</Chip>}>
        {cands === null ? <Empty>Loading…</Empty> : live.length === 0 ? <Empty>No live strategies yet. Candidates are promoted once their paper record clears the rules ({rules.minTrades}+ trades, ≥ {rules.minExpectancy}R per trade, PF ≥ {rules.minProfitFactor}).</Empty> : (
          <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))" }}>
            {live.map((c) => (
              <div key={c.key} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6, borderLeft: "3px solid var(--up)" }}>
                <div className="between"><b style={{ fontWeight: 500 }}>{c.instrument} · {name(c)}</b><span className="row" style={{ gap: 4 }}>{c.pinned && <Chip tone="acc">pinned</Chip>}<Chip tone="up" dot>live {days(c.live_since).toFixed(0)}d</Chip></span></div>
                <div className={`kv sm ${tone(st(c, "live").netR)}`}>{fmtR(st(c, "live").netR)} <span className="faint" style={{ fontSize: 11, fontWeight: 400 }}>since live</span></div>
                <StatLine s={st(c, "live")} label="live era" />
                <StatLine s={st(c, "recent")} label={`last ${rules.demoteLastN}`} />
                <StatLine s={st(c, "window")} label={`${rules.windowDays} days`} />
                {c.status_reason && <div className="faint" style={{ fontSize: 11 }}>{c.status_reason}</div>}
                <div className="row" style={{ gap: 6, marginTop: 2, flexWrap: "wrap" }}>
                  <Toggle on={c.route_alerts} onChange={(v) => act(c, { route_alerts: v })} label="Route to live alerts" />
                  <span className="faint" style={{ fontSize: 11 }}>alerts</span>
                  <span style={{ flex: 1 }} />
                  <button className="btn ghost sm" onClick={() => act(c, { pinned: !c.pinned })}>{c.pinned ? "Unpin" : "Pin"}</button>
                  <button className="btn sm" onClick={() => act(c, { pinned: false }, "benched", "benched by hand")}>Bench</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Candidates · best first" right={<span className="faint" style={{ fontSize: 11 }}>score = expectancy × √trades over {rules.windowDays} days</span>}>
        {waiting.length === 0 ? <Empty>No candidates scored yet: the autopilot scores them on its next pass.</Empty> : (
          <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))" }}>
            {waiting.slice(0, 18).map((c) => {
              const w = st(c, "window");
              const checks = promotionChecks(w, rules);
              const cooling = c.status === "benched" && c.benched_at ? Math.max(0, rules.cooldownDays - days(c.benched_at)) : 0;
              return (
                <div key={c.key} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6, borderLeft: c.stats.ready ? "3px solid var(--accent)" : "3px solid transparent" }}>
                  <div className="between"><b style={{ fontWeight: 500 }}>{c.instrument} · {name(c)}</b><Chip tone={c.stats.ready ? "acc" : c.status === "benched" ? "warn" : ""}>{c.stats.ready ? "ready" : c.status}</Chip></div>
                  <div className="between"><span className={`kv sm ${tone(w.netR)}`}>{fmtR(w.netR)}</span><span className="mono faint" style={{ fontSize: 11 }}>score {w.score}</span></div>
                  <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>{checks.map((k) => <Chip key={k.label} tone={k.ok ? "up" : ""}>{k.ok ? "✓" : "✗"} {k.label} · {k.value}</Chip>)}</div>
                  <StatLine s={st(c, "allTime")} label="all time" />
                  {c.status === "benched" && <div className="faint" style={{ fontSize: 11 }}>Benched: {c.status_reason ?? "—"}{cooling ? ` · eligible in ${cooling.toFixed(1)}d` : ""}</div>}
                  <div className="row" style={{ gap: 6 }}>
                    <span style={{ flex: 1 }} />
                    <button className="btn sm" disabled={live.length >= rules.maxLive} title={live.length >= rules.maxLive ? "Live slots are full" : undefined} onClick={() => act(c, {}, "live", `promoted by hand · ${w.expectancy}R/trade over ${w.n} trades`)}>Promote</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <section className="g12">
        <Card span={6} title="Rules" right={<button className="btn pri sm" onClick={saveRules}>Save rules</button>}>
          <div className="col" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
              <span className="row" style={{ gap: 6 }}><Toggle on={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Promotion on" /><span style={{ fontSize: 12 }}>Promotion</span></span>
              <span className="row" style={{ gap: 6 }}><Toggle on={form.autoPromote} onChange={(v) => setForm({ ...form, autoPromote: v })} label="Auto-promote" /><span style={{ fontSize: 12 }}>Auto-promote</span></span>
              <span className="row" style={{ gap: 6 }}><Toggle on={form.autoDemote} onChange={(v) => setForm({ ...form, autoDemote: v })} label="Auto-bench" /><span style={{ fontSize: 12 }}>Auto-bench</span></span>
              <span className="row" style={{ gap: 6 }}><Toggle on={form.requireRecentPositive} onChange={(v) => setForm({ ...form, requireRecentPositive: v })} label="Last 10 must be positive" /><span style={{ fontSize: 12 }}>Last 10 ≥ 0R</span></span>
            </div>
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(150px, 100%), 1fr))" }}>
              {([
                ["windowDays", "Look-back (days)"], ["minTrades", "Min trades"], ["minExpectancy", "Min R / trade"], ["minProfitFactor", "Min profit factor"],
                ["maxDrawdownR", "Max drawdown (R)"], ["maxLive", "Live slots"], ["demoteLastN", "Bench: last N trades"], ["demoteExpectancy", "Bench below R / trade"],
                ["demoteProfitFactor", "Bench below PF"], ["demoteDrawdownR", "Bench at live DD (R)"], ["cooldownDays", "Cool-down (days)"], ["swapMargin", "Swap when score ×"],
              ] as [keyof PromotionRules, string][]).map(([k, l]) => (
                <label key={k} className="fld"><span>{l}</span><div className="inp"><input type="number" step="any" value={String(form[k])} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} /></div></label>
              ))}
            </div>
            <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setForm(DEFAULT_RULES)}>Reset to defaults</button>
          </div>
        </Card>
        <Card span={6} title="Live alert chats" right={<button className="btn sm" onClick={saveChats}>Save</button>}>
          <label className="fld"><span>Telegram chat IDs for live signals, one per line (id:label). Empty = the firm&apos;s alert chats.</span>
            <div className="inp txt" style={{ height: "auto" }}><textarea rows={3} value={chats} onChange={(e) => setChats(e.target.value)} placeholder="-1001234567890:Live desk" style={{ width: "100%", border: 0, background: "transparent", color: "inherit", font: "inherit", padding: "8px 0", resize: "vertical" }} /></div>
          </label>
          <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>Each new signal of a live strategy goes out once as a 🔴 LIVE ticket (entry, stop, target, R) and lands in the bell under Live strategies. Turn routing off per strategy on its card.</p>
          <h4 style={{ margin: "14px 0 6px", fontSize: 12.5 }}>History</h4>
          {events.length === 0 ? <Empty>No promotions or benchings yet</Empty> : (
            <div className="col" style={{ gap: 6, maxHeight: 260, overflowY: "auto" }}>
              {events.map((e) => (
                <div key={e.id} style={{ fontSize: 12 }}>
                  <Chip tone={e.to_status === "live" ? "up" : e.to_status === "benched" ? "warn" : ""}>{e.to_status}</Chip> <b style={{ fontWeight: 500 }}>{e.key}</b> <span className="faint mono" style={{ fontSize: 10.5 }}>{new Date(e.at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  {e.reason && <div className="faint" style={{ fontSize: 11 }}>{e.reason}</div>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>
    </>
  );
}
