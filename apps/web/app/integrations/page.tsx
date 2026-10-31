"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { staffGet } from "@/lib/market";
import { useApi } from "@/lib/useApi";
import { Card, Chip } from "@/components/ui";
import IntegrationsCard from "@/components/IntegrationsCard";

type DeltaStatus = { mode: string; env: string; deltaEnv: string; relay: boolean; keys: { testnet: boolean; production: boolean }; productsError?: string; wallet?: unknown };
type HostVenue = { id: string; env: string; keys: boolean; execution: boolean; note?: string; symbols: string[];
  clock: { offsetMs: number | null; rttP95Ms: number | null; healthy: boolean; budgetMs: number };
  stream: { state: string; lastMessageAt: number | null; reconnects: number; error: string | null } };
type Host = { connected: boolean; reason?: string; publicIp?: string | null; uptimeSec?: number; venues?: HostVenue[]; store?: { enabled: boolean; written: number; buffered: number; error: string | null } };
const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v >= 0 && v !== 0 ? "+" : ""}${Math.round(v)} ms`);
const ago = (t: number | null) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} s ago` : "—");
/** Card metrics and rows from the engine host's view of one venue. */
const fromHost = (h: HostVenue): Pick<Venue, "metrics" | "rows" | "status" | "label"> => ({
  status: h.clock.healthy && h.keys ? "ok" : h.keys || h.stream.state !== "off" ? "warn" : "off",
  label: !h.keys ? (h.note ? "Needs setup" : "Keys missing") : h.clock.healthy ? (h.execution ? "Trading on" : "Connected") : "Clock check",
  metrics: [["Clock offset", ms(h.clock.offsetMs)], ["Round trip p95", h.clock.rttP95Ms === null ? "—" : `${Math.round(h.clock.rttP95Ms)} ms`], ["Stream", h.stream.state]],
  rows: [["Last message", ago(h.stream.lastMessageAt)], ["Clock budget", `±${h.clock.budgetMs} ms`], ["Execution switch", h.execution ? "on" : "off"], ["Markets", h.symbols.join(", ")], ...(h.stream.error ? [["Last error", h.stream.error] as [string, string]] : []), ...(h.note ? [["To do", h.note] as [string, string]] : [])],
});

type Venue = { id: string; name: string; logo: string; ac: string; sub: string; status: "ok" | "warn" | "off"; label: string; metrics: [string, string][]; rows: [string, string][] };

/** Round trip from this browser to a venue's public endpoint, measured on load. */
function useRtt(path: string) {
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    const t0 = performance.now();
    fetch(path, { cache: "no-store" }).then(() => setMs(Math.round(performance.now() - t0))).catch(() => setMs(null));
  }, [path]);
  return ms;
}

function VenueCard({ v }: { v: Venue }) {
  return (
    <Card span={4} style={{ "--ac": `var(${v.ac})` } as CSSProperties}>
      <div className="venue-hd">
        <div className="vl">{v.logo}</div>
        <div><b>{v.name}</b><div className="faint" style={{ fontSize: 12.5 }}>{v.sub}</div></div>
        <span style={{ marginLeft: "auto" }}><Chip tone={v.status === "ok" ? "up" : v.status === "warn" ? "warn" : ""} dot>{v.label}</Chip></span>
      </div>
      <div className="vm">{v.metrics.map(([k, x]) => <div key={k}><small>{k}</small><b>{x}</b></div>)}</div>
      {v.rows.map(([k, x]) => <div key={k} className="between" style={{ padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}><span className="muted">{k}</span><span>{x}</span></div>)}
    </Card>
  );
}

export default function IntegrationsPage() {
  const [delta, setDelta] = useState<DeltaStatus | null>(null);
  const [deltaErr, setDeltaErr] = useState<string | null>(null);
  const [host, setHost] = useState<Host | null>(null);
  useEffect(() => { staffGet<DeltaStatus>("/api/delta").then(setDelta, (e: Error) => setDeltaErr(e.message)); }, []);
  useEffect(() => {
    const load = () => staffGet<Host>("/api/engine/status").then(setHost, (e: Error) => setHost({ connected: false, reason: e.message }));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const hv = (id: string) => (host?.connected ? host.venues?.find((v) => v.id === id) : undefined);
  const deltaMkt = useApi<{ at: number }>("/api/market/delta?symbol=BTCUSD", 30_000);
  const rtt = useRtt("/api/market/delta?symbol=BTCUSD");
  const skew = deltaMkt.data ? Math.round(Date.now() - deltaMkt.data.at) : null;

  const keys = delta ? (delta.env === "production" ? delta.keys.production : delta.keys.testnet) : false;
  const venues: Venue[] = [
    {
      id: "delta", name: "Delta Exchange India", logo: "Δ", ac: "--delta", sub: delta ? `${delta.env} · mode ${delta.mode}` : "API trading",
      status: deltaErr ? "warn" : delta && keys ? "ok" : "warn", label: deltaErr ? "Check" : delta ? (keys ? "Connected" : "Keys missing") : "Checking",
      metrics: [["Round trip", rtt === null ? "—" : `${rtt} ms`], ["Data age", skew === null ? "—" : `${(skew / 1000).toFixed(1)} s`], ["Relay", delta ? (delta.relay ? "on" : "off") : "—"]],
      rows: [["Signing", "HMAC-SHA256 · 5 s window"], ["Keys", delta ? `testnet ${delta.keys.testnet ? "✓" : "—"} · production ${delta.keys.production ? "✓" : "—"}` : deltaErr ?? "…"], ["Whitelisted IP", delta?.relay ? "engine host" : "needs the engine host"], ["Products", delta?.productsError ? "unreachable" : "BTCUSD, XAUTUSD"]],
    },
    {
      id: "coinswitch", name: "CoinSwitch PRO", logo: "CS", ac: "--cs", sub: "HFT API · Ed25519", status: "off", label: "Not connected",
      metrics: [["Round trip", "—"], ["Clock offset", "—"], ["Rate used", "—"]],
      rows: [["Signing", "Ed25519 · epoch in ms"], ["Whitelisted IP", "needs the engine host"], ["Options", "beta access to request"], ["Mode", "paper"]],
    },
    {
      id: "fyers", name: "Fyers", logo: "F", ac: "--fyers", sub: "API v3 · NSE / BSE", status: "off", label: "Not connected",
      metrics: [["Round trip", "—"], ["Clock offset", "—"], ["Rate used", "—"]],
      rows: [["Static IP (SEBI)", "register the engine host's IP"], ["Session token", "daily login"], ["Refresh token", "15 days with PIN"], ["Mode", "paper"]],
    },
    {
      id: "ctrader", name: "cTrader · prop accounts", logo: "cT", ac: "--cfd", sub: "FundedHive · The5ers", status: "warn", label: "Alerts only",
      metrics: [["Accounts", "2"], ["Orders from app", "never"], ["Sync", "—"]],
      rows: [["Telegram alerts", "carry cTrader signal links"], ["Position sync", "read-only, once Open API is linked"], ["Prices", "cTrader demo feed (to connect)"]],
    },
  ];

  const shown = venues.map((v) => { const h = hv(v.id); return h ? { ...v, ...fromHost(h) } : v; });

  return (
    <>
      <div className="page-h"><div><h1>Integrations</h1><p>Connections, keys and clock sync for each venue. Trading keys live on the engine host, never in the browser or Vercel.</p></div></div>
      <section className="g12">
        <VenueCard v={{
          id: "host", name: "Engine host", logo: "⌁", ac: "--accent", sub: "DigitalOcean · Bangalore",
          status: host?.connected ? "ok" : "off", label: host ? (host.connected ? "Online" : "Not connected") : "Checking",
          metrics: [["Static IP", host?.publicIp ?? "—"], ["Uptime", host?.uptimeSec ? `${Math.floor(host.uptimeSec / 3600)}h ${Math.floor((host.uptimeSec % 3600) / 60)}m` : "—"], ["Ticks stored", host?.store?.enabled ? String(host.store.written) : "off"]],
          rows: host?.connected
            ? [["Tick store", host.store?.enabled ? (host.store.error ? `error: ${host.store.error}` : `${host.store.buffered} buffered`) : "memory only"], ["Venues", (host.venues ?? []).map((v) => v.id).join(", ")]]
            : [["Status", host?.reason ?? "…"], ["Set up", "services/engine/README.md"], ["Vercel", "ENGINE_URL and ENGINE_SECRET"]],
        }} />
        {shown.map((v) => <VenueCard key={v.id} v={v} />)}
      </section>
      <IntegrationsCard />
    </>
  );
}
