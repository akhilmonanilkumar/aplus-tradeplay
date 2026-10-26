"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { useMe } from "@/components/Shell";
import IntegrationsCard from "@/components/IntegrationsCard";
import type { TradingAccount } from "@/lib/types";
import { dateShort } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Note, Table, Toggle } from "@/components/ui";

type EdgeConfig = { id: string; version: string; active: boolean; config: Record<string, unknown>; created_at: string };
type Cred = { account_id: string; vault_secret_id: string; can_trade: boolean; ip_locked: boolean; rotated_at: string };
type Factor = { id: string; friendly_name?: string; factor_type: string; status: string; created_at: string };

function flatten(o: unknown, p = ""): Record<string, string> {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return { [p]: JSON.stringify(o) };
  return Object.entries(o as Record<string, unknown>).reduce((a, [k, v]) => ({ ...a, ...flatten(v, p ? `${p}.${k}` : k) }), {} as Record<string, string>);
}

const Srow = ({ t, d, children }: { t: string; d?: string; children: React.ReactNode }) => (
  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "11px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
    <div className="col" style={{ gap: 1 }}><b style={{ fontWeight: 500 }}>{t}</b>{d && <span className="faint" style={{ fontSize: 11.5 }}>{d}</span>}</div>{children}
  </div>
);

export default function Settings() {
  const me = useMe();
  const edge = useRows<EdgeConfig>({ table: "edge_configs", order: "created_at" });
  const creds = useRows<Cred>({ table: "venue_credentials" });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,venue" });
  const [factors, setFactors] = useState<Factor[]>([]);
  const [enroll, setEnroll] = useState<{ id: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [cmp, setCmp] = useState<string>("");
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const loadFactors = () => supabase.auth.mfa.listFactors().then(({ data }) => setFactors((data?.all ?? []) as Factor[]));
  useEffect(() => { loadFactors(); }, []);
  const verified = factors.filter((f) => f.status === "verified");
  const active = (edge.rows ?? []).find((e) => e.active) ?? null;
  const other = (edge.rows ?? []).find((e) => e.id === cmp) ?? null;
  const diff = active && other ? (() => { const a = flatten(active.config), b = flatten(other.config); return Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).filter((k) => a[k] !== b[k]).map((k) => ({ k, now: a[k], was: b[k] })); })() : [];

  const addBackup = async () => {
    const r = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Backup ${verified.length + 1}` });
    if (r.error) return setMsg({ ok: false, t: r.error.message });
    setEnroll({ id: r.data.id, qr: r.data.totp.qr_code });
  };
  const confirmBackup = async () => {
    if (!enroll) return;
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll.id, code });
    if (error) return setMsg({ ok: false, t: error.message });
    setEnroll(null); setCode(""); loadFactors(); setMsg({ ok: true, t: "Backup authenticator added" });
  };
  const signOutOthers = async () => { const { error } = await supabase.auth.signOut({ scope: "others" }); setMsg(error ? { ok: false, t: error.message } : { ok: true, t: "Other sessions signed out" }); };
  const saveEdge = async () => {
    if (editing === null || !active) return;
    let cfg: unknown;
    try { cfg = JSON.parse(editing); } catch { return setMsg({ ok: false, t: "Config is not valid JSON" }); }
    const [maj, min] = active.version.split(".").map(Number) as [number, number];
    const version = `${maj}.${(min ?? 0) + 1}`;
    const ins = await supabase.from("edge_configs").insert({ version, active: false, config: cfg }).select("id").single();
    if (ins.error) return setMsg({ ok: false, t: ins.error.message });
    await supabase.from("edge_configs").update({ active: false }).eq("id", active.id);
    await supabase.from("edge_configs").update({ active: true }).eq("id", ins.data.id);
    setEditing(null); edge.reload(); setMsg({ ok: true, t: `Edge v${version} is active` });
  };
  const exportAll = async () => {
    const tables = ["trading_accounts", "investors", "prop_purchases", "signals", "orders", "trades", "payouts", "bias_reports", "setups", "news_events", "subscription_plans", "tg_members", "tg_events", "tg_posts", "tracked_links", "copy_routes", "edge_configs", "alert_rules", "mood_checkins"];
    const out: Record<string, unknown> = { exported_at: new Date().toISOString() };
    for (const t of tables) { const { data } = await supabase.from(t).select("*").limit(50000); out[t] = data ?? []; }
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `aplus-tradeplay-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
  };
  const acc = (id: string) => (accounts.rows ?? []).find((a) => a.id === id);

  return (
    <>
      <ErrorNote error={edge.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="g12">
        <Card span={6} title="Security" right={<Chip tone={verified.length ? "up" : "warn"}>{verified.length >= 2 ? "Strong" : verified.length ? "Good" : "Weak"}</Chip>}>
          <Srow t="Authenticator app (TOTP)" d={verified[0] ? `Required for owner and admin · added ${dateShort(verified[0].created_at)}` : "Required for owner and admin"}><Chip tone={verified.length ? "up" : "warn"}>{verified.length ? "On" : "Off"}</Chip></Srow>
          <Srow t="Backup authenticator" d={verified.length > 1 ? `${verified.length - 1} backup device${verified.length > 2 ? "s" : ""}` : "A second device so a lost phone can't lock you out"}><button className="btn sm" onClick={addBackup}>Add backup</button></Srow>
          {enroll && (
            <div className="row" style={{ padding: "10px 0", gap: 12 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enroll.qr} alt="Backup authenticator QR" style={{ width: 120, height: 120, background: "#fff", borderRadius: 10, padding: 6 }} />
              <div className="col" style={{ gap: 8 }}>
                <div className="inp" style={{ width: 160 }}><input aria-label="Code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></div>
                <button className="btn pri sm" disabled={code.length !== 6} onClick={confirmBackup}>Verify</button>
              </div>
            </div>
          )}
          <Srow t="Step-up check" d="Fresh code for LIVE mode and payout approval"><Chip>Locked on</Chip></Srow>
          <div className="lbl-u" style={{ margin: "14px 0 4px" }}>Sessions</div>
          <Srow t={me.session.user.email ?? "This device"} d="This device"><Chip tone="acc">Current</Chip></Srow>
          <Srow t="All other devices" d="Ends every other signed-in session"><button className="btn ghost sm" onClick={signOutOthers}>Sign out</button></Srow>
        </Card>
        <Card span={6} title="Venue key vault" right={<Chip>Live execution · next release</Chip>}>
          {(creds.rows ?? []).length === 0 ? <Empty>No venue keys stored</Empty> : (
            <Table head={["Venue", "Key", "Permissions", "IP lock", "Rotated"]} right={[4]}>
              {(creds.rows ?? []).map((c) => (
                <tr key={c.account_id}><td>{acc(c.account_id)?.venue ?? "—"} <span className="faint" style={{ fontSize: 11 }}>{acc(c.account_id)?.name}</span></td><td className="mono">vault ••••{c.vault_secret_id.slice(-4)}</td><td><Chip tone="up">{c.can_trade ? "Trade" : "Read"}</Chip></td><td className="mono">{c.ip_locked ? "Locked" : "Open"}</td><td className="r mono faint">{dateShort(c.rotated_at)}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      </section>

      <IntegrationsCard />

      <section className="g12">
        <Card span={7} title={<>Edge configuration {active && <Chip tone="acc">v{active.version}</Chip>}</>} right={<>
          <div className="inp" style={{ width: 150, height: 30 }}><select aria-label="Compare with" value={cmp} onChange={(e) => setCmp(e.target.value)}><option value="">Compare…</option>{(edge.rows ?? []).filter((e) => !e.active).map((e) => <option key={e.id} value={e.id}>v{e.version}</option>)}</select></div>
          {editing === null ? <button className="btn pri sm" onClick={() => setEditing(JSON.stringify(active?.config ?? {}, null, 2))} disabled={!active}>Edit</button> : <><button className="btn sm" onClick={() => setEditing(null)}>Cancel</button><button className="btn pri sm" onClick={saveEdge}>Save as new version</button></>}
        </>}>
          {editing !== null ? <textarea className="inp mono" style={{ minHeight: 300, fontSize: 11.5 }} value={editing} onChange={(e) => setEditing(e.target.value)} /> : (
            <pre className="mono" style={{ fontSize: 11.5, whiteSpace: "pre", overflow: "auto", maxHeight: 300, padding: 12, borderRadius: 12, background: "var(--surface-2)", border: "1px solid var(--line)", color: "var(--muted)", margin: 0 }}>{active ? JSON.stringify(active.config, null, 2) : "—"}</pre>
          )}
          {other && (
            <div style={{ marginTop: 10 }}>
              <div className="lbl-u" style={{ marginBottom: 6 }}>v{active?.version} vs v{other.version} · {diff.length} changes</div>
              {diff.slice(0, 20).map((d) => <div key={d.k} className="mono" style={{ fontSize: 11.5, padding: "3px 0" }}><span className="faint">{d.k}</span> <span className="down">{d.was ?? "—"}</span> → <span className="up">{d.now ?? "—"}</span></div>)}
            </div>
          )}
          <div className="lbl-u" style={{ margin: "14px 0 4px" }}>Entry models</div>
          <Srow t="Aggressive entries (models D, E)" d="Enter on the sweep without waiting for the shift · capped at grade A"><Toggle on={!!me.settings?.aggressive_entry_allowed} onChange={(v) => me.updateSettings({ aggressive_entry_allowed: v })} label="Aggressive entries" /></Srow>
          <Srow t="Advanced models (G, H, I)" d="Counter-trend scalp, sniper, post-news · never A+"><Toggle on={!!me.settings?.advanced_models_allowed} onChange={(v) => me.updateSettings({ advanced_models_allowed: v })} label="Advanced models" /></Srow>
          <Srow t="Counter-trend (model G)" d="Trades against the HTF trend"><Toggle on={!!me.settings?.counter_trend_allowed} onChange={(v) => me.updateSettings({ counter_trend_allowed: v })} label="Counter-trend" /></Srow>
        </Card>
        <Card span={5} title="Preferences">
          <Srow t="Times shown in">{<Chip tone="acc">IST · ET · UTC</Chip>}</Srow>
          <Srow t="Indian digit grouping for ₹">{<Chip>1,00,000</Chip>}</Srow>
          <Srow t="Execution mode"><span className={`live-pill ${me.settings?.mode === "LIVE" ? "live" : "paper"}`}><span className="dot" />{me.settings?.mode ?? "PAPER"}</span></Srow>
          <Srow t="Export all my data" d="JSON file of every table you can read"><button className="btn sm" onClick={exportAll}>Download</button></Srow>
        </Card>
      </section>
    </>
  );
}
