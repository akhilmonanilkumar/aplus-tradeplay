"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { TradingAccount } from "@/lib/types";
import { dateShort } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote, Note, Table, Toggle } from "@/components/ui";

type Cred = { account_id: string; can_trade: boolean; ip_locked: boolean; rotated_at: string };
type Hook = { id: string; name: string; url: string; events: string[]; signing: string; last_status: string | null; last_at: string | null; enabled: boolean };
const MODES = ["Off", "Paper", "Confirm", "Auto"] as const;
const NOTE: Record<string, string> = { Off: "Engine logs setups only.", Paper: "Orders go to paper / testnet and the journal.", Confirm: "Ticket pre-filled; you tap to send.", Auto: "Sends on GO within risk limits." };
const CHIP: Record<string, "" | "info" | "warn" | "up"> = { Off: "", Paper: "info", Confirm: "warn", Auto: "up" };
const KIND: Record<string, string> = {
  Binance: "Exchange · USDⓈ-M API", "Delta Exchange India": "Exchange · REST + WS", CoinSwitch: "Exchange · PRO API", cTrader: "cTrader Open API",
  MT5: "MT5 bridge", The5ers: "Prop · cTrader / MT5", FundedHive: "Prop · MT5", FundedIN: "Prop", Breakout: "Prop · no API (manual)",
  "Zerodha (MCX)": "Broker · Kite Connect", "Dhan (MCX)": "Broker · DhanHQ", "Groww (MCX)": "Broker", "TradingView paper": "Paper",
};

export default function Connections() {
  const me = useMe();
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const creds = useRows<Cred>({ table: "venue_credentials", select: "account_id,can_trade,ip_locked,rotated_at" });
  const hooks = useRows<Hook>({ table: "webhooks_out", order: "created_at", ascending: true });
  const [keyFor, setKeyFor] = useState<TradingAccount | null>(null);
  const [secret, setSecret] = useState("");
  const [ipLocked, setIpLocked] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [nh, setNh] = useState({ name: "", url: "", events: "ARMED,filled" });
  const [addHook, setAddHook] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(location.origin), []);

  const modes = me.settings?.auto_modes ?? {};
  const setMode = (inst: string, m: string) => me.updateSettings({ auto_modes: { ...modes, [inst]: m as "Off" } });
  const cred = (id: string) => (creds.rows ?? []).find((c) => c.account_id === id);

  const saveKey = async () => {
    if (!keyFor) return;
    const { error } = await supabase.rpc("store_venue_secret", { p_account: keyFor.id, p_secret: secret, p_ip_locked: ipLocked });
    setSecret("");
    if (error) return setMsg({ ok: false, t: error.message });
    setMsg({ ok: true, t: `Key stored in Vault for ${keyFor.name}` });
    setKeyFor(null); creds.reload();
  };
  const rotateToken = async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const e = await me.updateSettings({ webhook_token: token });
    setMsg(e ? { ok: false, t: e } : { ok: true, t: "Webhook token rotated — update your TradingView alerts" });
  };
  const saveHook = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.from("webhooks_out").insert({ name: nh.name.trim(), url: nh.url.trim(), events: nh.events.split(",").map((x) => x.trim()).filter(Boolean) });
    if (error) return setMsg({ ok: false, t: error.message });
    setAddHook(false); setNh({ name: "", url: "", events: "ARMED,filled" }); hooks.reload();
  };
  const token = me.settings?.webhook_token ?? "";
  const masked = token ? `${token.slice(0, 4)}••••••••${token.slice(-4)}` : "—";

  return (
    <>
      <ErrorNote error={accounts.error || creds.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="card">
        <div className="ch"><h3>Auto-trade copilot</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>What happens when the engine says GO</span></div>
        <div className="auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))", gap: 12 }}>
          {["XAUUSD", "BTCUSDT.P", "GOLDM"].map((inst) => {
            const cur = modes[inst] ?? "Off";
            return (
              <div key={inst} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 16, background: "var(--surface-2)", border: "1px solid var(--line)" }}>
                <div className="between"><b>{inst === "GOLDM" ? "MCX GOLDM" : inst}</b><Chip tone={CHIP[cur]}>{cur}</Chip></div>
                <div className="seg" role="group" aria-label="Auto-trade mode" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
                  {MODES.map((m) => <button key={m} type="button" className={m === cur ? "on" : ""} onClick={() => setMode(inst, m)}>{m}</button>)}
                </div>
                <span className="faint" style={{ fontSize: 11.5 }}>{NOTE[cur]}{cur === "Auto" && me.settings?.mode === "PAPER" ? " Execution mode is PAPER." : ""}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", gap: 12 }}>
        {(accounts.rows ?? []).length === 0 && <Empty>Add accounts first</Empty>}
        {(accounts.rows ?? []).map((a) => {
          const c = cred(a.id);
          const manual = a.venue === "Breakout" || a.venue === "TradingView paper";
          return (
            <div key={a.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <span style={{ width: 38, height: 38, borderRadius: 12, background: "var(--surface-3)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 13, color: "var(--muted)", flex: "0 0 38px" }}>{a.venue.slice(0, 2).toUpperCase()}</span>
                <div className="col" style={{ gap: 1, flex: 1, minWidth: 0 }}><b>{a.name}</b><span className="faint" style={{ fontSize: 11.5 }}>{KIND[a.venue] ?? a.venue}</span></div>
                <Chip tone={c ? "up" : manual ? "warn" : ""} dot>{c ? "Key stored" : manual ? "Manual" : "Not connected"}</Chip>
              </div>
              <div className="col" style={{ gap: 5 }}>
                <div className="between" style={{ fontSize: 12 }}><span className="muted">Copy policy</span><span className="mono">{a.copy_policy}</span></div>
                <div className="between" style={{ fontSize: 12 }}><span className="muted">Permissions</span><span className="mono">{c ? `trade${c.ip_locked ? " · IP-locked" : ""} · no withdraw` : "—"}</span></div>
                <div className="between" style={{ fontSize: 12 }}><span className="muted">Rotated</span><span className="mono">{c ? dateShort(c.rotated_at) : "—"}</span></div>
              </div>
              <div className="row"><button className="btn sm" disabled={manual} onClick={() => setKeyFor(a)}>{c ? "Rotate key" : "Add API key"}</button><span style={{ flex: 1 }} /><span className="faint" style={{ fontSize: 11 }}>{c ? "Supabase Vault" : manual ? "tickets in Copy Engine" : ""}</span></div>
            </div>
          );
        })}
      </section>

      <section className="g12">
        <Card span={6} title="Inbound webhook · TradingView alerts" right={<><Chip tone={token ? "up" : ""}>{token ? "Active" : "—"}</Chip><button className="btn sm" onClick={rotateToken}>Rotate</button></>}>
          <div className="col" style={{ gap: 10 }}>
            <div className="fld"><span>Alert URL (secret path token)</span><div className="mono" style={{ fontSize: 12, padding: "9px 11px", borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--line)", overflowX: "auto", whiteSpace: "nowrap" }}>{origin}/api/hooks/tv/{masked}</div></div>
            <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => navigator.clipboard?.writeText(`${origin}/api/hooks/tv/${token}`)}>Copy full URL</button>
            <div className="fld"><span>Message body</span><div className="mono" style={{ fontSize: 12, padding: "9px 11px", borderRadius: 10, background: "var(--surface-2)", border: "1px solid var(--line)", overflowX: "auto", whiteSpace: "nowrap" }}>{'{"symbol":"{{ticker}}","side":"buy","price":{{close}},"note":"{{interval}}"}'}</div></div>
          </div>
        </Card>
        <Card span={6} title="Outbound webhooks" right={<button className="btn sm" onClick={() => setAddHook((v) => !v)}>{addHook ? "Close" : "Add endpoint"}</button>}>
          {addHook && (
            <form onSubmit={saveHook} className="auto-s" style={{ marginBottom: 12 }}>
              <label className="fld"><span>Name</span><div className="inp txt"><input value={nh.name} onChange={(e) => setNh({ ...nh, name: e.target.value })} required /></div></label>
              <label className="fld"><span>HTTPS URL</span><div className="inp txt"><input value={nh.url} onChange={(e) => setNh({ ...nh, url: e.target.value })} required /></div></label>
              <label className="fld"><span>Events</span><div className="inp"><input value={nh.events} onChange={(e) => setNh({ ...nh, events: e.target.value })} /></div></label>
              <div style={{ alignSelf: "end" }}><button className="btn pri sm">Save</button></div>
            </form>
          )}
          {(hooks.rows ?? []).length === 0 ? <Empty>No endpoints</Empty> : (
            <Table head={["Endpoint", "Events", "Signing", "Last", "On"]} right={[3]}>
              {(hooks.rows ?? []).map((h) => (
                <tr key={h.id}>
                  <td className="mono">{h.name}</td><td>{h.events.join(" · ")}</td><td>{h.signing}</td>
                  <td className="r">{h.last_status ? <Chip tone={h.last_status.startsWith("2") ? "up" : "down"}>{h.last_status}</Chip> : <span className="faint">—</span>}</td>
                  <td><Toggle on={h.enabled} onChange={async (v) => { await supabase.from("webhooks_out").update({ enabled: v }).eq("id", h.id); hooks.reload(); }} label={`Endpoint ${h.name}`} /></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </section>

      {keyFor && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="API key">
          <div className="card">
            <div className="ch"><h3>{keyFor.name} · API key</h3><span className="sp" /><button className="btn ghost sm" onClick={() => { setKeyFor(null); setSecret(""); }}>Close</button></div>
            <p className="muted" style={{ fontSize: 12.5 }}>Trade permission only — never enable withdrawals. The secret goes straight into Supabase Vault; the app never shows it again.</p>
            <label className="fld" style={{ marginTop: 12 }}><span>Secret (key:secret)</span><div className="inp"><input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></div></label>
            <div className="between" style={{ marginTop: 10, fontSize: 12.5 }}><span>Key is IP-locked at the venue</span><Toggle on={ipLocked} onChange={setIpLocked} label="IP locked" /></div>
            <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}><button className="btn pri" disabled={secret.length < 8} onClick={saveKey}>Store in Vault</button></div>
          </div>
        </div>
      )}
    </>
  );
}
