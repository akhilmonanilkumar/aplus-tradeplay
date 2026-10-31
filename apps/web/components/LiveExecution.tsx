"use client";

import { useCallback, useEffect, useState } from "react";
import { staffGet } from "@/lib/market";
import { supabase } from "@/lib/supabase";
import { useMe } from "@/components/Shell";
import { DEFAULT_POLICY, HARD_CAPS, policyFrom, type LivePolicy } from "@/lib/liveRisk";
import { money, num } from "@/lib/fmt";
import { Card, Chip, Empty, Note, Row } from "@/components/ui";

/**
 * Delta Exchange execution for promoted strategies: mode (off → dry run → testnet → production, the last
 * two behind a fresh 2FA code), venue status, halt, the risk policy and every order the gate planned.
 */

type Mode = "off" | "dry-run" | "testnet" | "production";
interface State { mode: Mode; policy: Partial<LivePolicy>; halted_until: string | null; halt_reason: string | null; peak_equity: number | null; day_start_equity: number | null; dry_run_equity: number; last_sync_at: string | null; last_error: string | null }
interface Order {
  id: string; created_at: string; candidate_key: string; mode: string; symbol: string; side: string; contracts: number; limit_price: number | null; stop: number | null; target: number | null;
  risk_usd: number | null; rr: number | null; basis: number | null; status: string; reasons: string[]; error: string | null; fill_price: number | null; exit_price: number | null; pnl: number | null; meta: { strategy?: string; instrument?: string };
}
interface Status { mode: Mode; env: string; deltaEnv: string; relay: boolean; keys: { testnet: boolean; production: boolean }; products?: { symbol: string; productId?: number; contractValue?: number; missing?: boolean }[]; wallet?: unknown; positions?: unknown; openOrders?: unknown }

const MODES: { v: Mode; l: string; d: string }[] = [
  { v: "off", l: "Off", d: "Nothing is planned or sent" },
  { v: "dry-run", l: "Dry run", d: "Plans every order through the risk gate and records it; sends nothing" },
  { v: "testnet", l: "Testnet", d: "Sends real orders to the Delta demo account" },
  { v: "production", l: "Production", d: "Real money. Needs DELTA_ENV=production and production keys (via the relay)" },
];
const TONE: Record<string, "up" | "down" | "warn" | "info" | "acc" | ""> = { filled: "up", closed: "info", open: "acc", submitted: "acc", "dry-run": "info", rejected: "", cancelled: "", error: "down" };
const FIELDS: [keyof LivePolicy, string, string][] = [
  ["riskPct", "Risk per trade", "%"], ["dailyLossPct", "Daily loss cap", "%"], ["maxLossesPerDay", "Stop after losses", ""], ["maxTradesPerDay", "Trades per day", ""],
  ["maxOpenRiskPct", "Open risk cap", "%"], ["maxPositions", "Max positions", ""], ["maxDrawdownPct", "Halt at drawdown", "%"], ["maxLeverage", "Max leverage", "×"],
  ["minRR", "Min R to target", "R"], ["maxEntryDriftR", "Max entry drift", "R"], ["signalTtlMin", "Signal max age", "min"], ["newsBlockMin", "News block", "min"],
  ["cancelAfterMin", "Cancel unfilled after", "min"], ["capitalCap", "Capital cap (blank = all)", "$"],
];
const usdBalance = (w: unknown) => Array.isArray(w) ? Number((w as { asset_symbol: string; balance: string }[]).find((b) => b.asset_symbol === "USD" || b.asset_symbol === "USDT")?.balance ?? NaN) : NaN;

export default function LiveExecution() {
  const me = useMe();
  const [st, setSt] = useState<State | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [form, setForm] = useState<LivePolicy>(DEFAULT_POLICY);
  const [dryEq, setDryEq] = useState("1000");
  const [pending, setPending] = useState<Mode | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const [s, o] = await Promise.all([
      supabase.from("live_exec_state").select("*").eq("id", 1).maybeSingle(),
      supabase.from("live_orders").select("*").order("created_at", { ascending: false }).limit(30),
    ]);
    if (s.error) { setMissing(true); return; }
    const state = s.data as State;
    setSt(state); setOrders((o.data ?? []) as Order[]);
    staffGet<Status>("/api/delta").then(setStatus, () => null);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (st) { setForm(policyFrom(st.policy)); setDryEq(String(st.dry_run_equity)); } }, [st?.policy, st?.dry_run_equity]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (patch: Record<string, unknown>, ok: string) => {
    const r = await supabase.from("live_exec_state").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1);
    setMsg(r.error ? { ok: false, t: r.error.message } : { ok: true, t: ok });
    load();
  };
  const setMode = async (m: Mode) => {
    if (m === "testnet" || m === "production") { setPending(m); setCode(""); return; }
    await save({ mode: m }, `Mode: ${m}`);
  };
  const confirm = async () => {
    const err = await me.stepUp(code.trim());
    if (err) return setMsg({ ok: false, t: err });
    await save({ mode: pending }, `Mode: ${pending}. Orders are sent from the next autopilot pass.`);
    setPending(null);
  };

  if (missing) return <Note tone="warn">Live execution tables are not in the database yet: apply migration 20261028120000_live_execution.sql.</Note>;
  const mode = st?.mode ?? "off";
  const halted = st?.halted_until && Date.parse(st.halted_until) > Date.now();
  const venueEq = usdBalance(status?.wallet);
  const positions = Array.isArray(status?.positions) ? (status!.positions as unknown[]).length : null;
  const working = Array.isArray(status?.openOrders) ? (status!.openOrders as unknown[]).length : null;
  const closed = orders.filter((o) => o.status === "closed");
  const net = closed.reduce((s, o) => s + Number(o.pnl ?? 0), 0);

  return (
    <>
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <Card title="Delta Exchange execution" right={<Chip tone={mode === "production" ? "down" : mode === "testnet" ? "acc" : mode === "dry-run" ? "info" : ""} dot>{mode}</Chip>}>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {MODES.map((m) => {
            const blocked = m.v === "production" && status?.deltaEnv !== "production";
            return <button key={m.v} type="button" title={m.d} disabled={blocked} className={`btn sm ${mode === m.v ? "pri" : "ghost"}`} onClick={() => setMode(m.v)}>{m.l}</button>;
          })}
        </div>
        <p className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>{MODES.find((m) => m.v === mode)?.d}. Only promoted strategies with execution on, on BTC (→ BTCUSD) and gold (→ XAUTUSD), can place orders, and every order passes the risk gate below.</p>
        {pending && (
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: 12.5 }}>Enter your authenticator code to switch to <b>{pending}</b>:</span>
            <div className="inp" style={{ width: 110 }}><input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Authenticator code" /></div>
            <button className="btn pri sm" disabled={code.trim().length < 6} onClick={confirm}>Confirm</button>
            <button className="btn ghost sm" onClick={() => setPending(null)}>Cancel</button>
          </div>
        )}
        {halted && (
          <Note tone="down">Live trading halted until {new Date(st!.halted_until!).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })} IST: {st!.halt_reason} <button className="btn sm" onClick={() => save({ halted_until: null, halt_reason: null, api_errors: [] }, "Halt cleared")}>Resume</button></Note>
        )}

        <section className="g12" style={{ marginTop: 10 }}>
          <div className="s4 col" style={{ gap: 0 }}>
            <Row k="Venue keys" v={<span>{status ? <>testnet {status.keys.testnet ? <Chip tone="up">set</Chip> : <Chip>missing</Chip>} · production {status.keys.production ? <Chip tone="up">set</Chip> : <Chip>missing</Chip>}</> : "…"}</span>} />
            <Row k="Route" v={status ? (status.relay ? "fixed-IP relay" : "direct from Vercel") : "…"} />
            <Row k="Delta env (Vercel)" v={status?.deltaEnv ?? "…"} />
            <Row k="Products" v={<span className="mono" style={{ fontSize: 11.5 }}>{status?.products?.map((p) => (p.missing ? `${p.symbol} missing` : `${p.symbol} #${p.productId}`)).join(" · ") ?? "…"}</span>} />
          </div>
          <div className="s4 col" style={{ gap: 0 }}>
            <Row k={mode === "dry-run" ? "Dry-run equity" : "Venue equity"} v={<span className="mono">{mode === "dry-run" ? money(st?.dry_run_equity ?? 0) : Number.isFinite(venueEq) ? money(venueEq) : "—"}</span>} />
            <Row k="Peak · day start" v={<span className="mono">{st?.peak_equity ? money(st.peak_equity, "USD", 0) : "—"} · {st?.day_start_equity ? money(st.day_start_equity, "USD", 0) : "—"}</span>} />
            <Row k="Positions · working" v={<span className="mono">{positions ?? "—"} · {working ?? "—"}</span>} />
            <Row k="Closed · net" v={<span className={`mono ${net >= 0 ? "up" : "down"}`}>{closed.length} · {money(net)}</span>} />
          </div>
          <div className="s4 col" style={{ gap: 0 }}>
            <Row k="Last sync" v={<span className="mono">{st?.last_sync_at ? new Date(st.last_sync_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" }) : "—"}</span>} />
            {st?.last_error && <div className="down" style={{ fontSize: 11.5, marginTop: 6 }}>Last error: {st.last_error}</div>}
            {mode === "dry-run" && (
              <label className="fld" style={{ marginTop: 8 }}><span>Dry-run equity (sizing)</span>
                <div className="row" style={{ gap: 6 }}><div className="inp" style={{ width: 120 }}><input type="number" value={dryEq} onChange={(e) => setDryEq(e.target.value)} /></div><button className="btn sm" onClick={() => save({ dry_run_equity: Number(dryEq) || 1000 }, "Dry-run equity saved")}>Save</button></div>
              </label>
            )}
          </div>
        </section>
      </Card>

      <section className="g12">
        <Card span={5} title="Risk policy" right={<button className="btn pri sm" onClick={() => save({ policy: policyFrom(form) }, "Risk policy saved (clamped to the hard caps)")}>Save</button>}>
          <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(150px, 100%), 1fr))" }}>
            {FIELDS.map(([k, l, u]) => {
              const cap = HARD_CAPS[k];
              return (
                <label key={k} className="fld"><span>{l}{u && <span className="faint"> · {u}</span>}</span>
                  <div className="inp"><input type="number" step="any" value={form[k] === null ? "" : String(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.value === "" ? null : Number(e.target.value) })} /></div>
                  {cap && <span className="faint" style={{ fontSize: 10.5 }}>limit {cap[0]}–{cap[1]}</span>}
                </label>
              );
            })}
          </div>
          <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Hard limits in code: risk ≤ 1% per trade, daily loss ≤ 3%, leverage ≤ 10×, drawdown halt ≤ 10%, 1 position per product. Every entry carries its stop-loss and take-profit; an order without a stop is never sent.</p>
        </Card>
        <Card span={7} title="Orders" right={<Chip>{orders.length} recent</Chip>}>
          {orders.length === 0 ? <Empty>No live orders yet. They appear when a promoted strategy signals on BTC or gold while the mode is not off.</Empty> : (
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(250px, 100%), 1fr))", maxHeight: 520, overflowY: "auto" }}>
              {orders.map((o) => (
                <div key={o.id} className="card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4, boxShadow: "none", background: "var(--surface-2)" }}>
                  <div className="between"><b style={{ fontWeight: 500, fontSize: 12.5 }}>{o.symbol} {o.side} {o.contracts || ""}</b><Chip tone={TONE[o.status] ?? ""}>{o.status}</Chip></div>
                  <div className="faint mono" style={{ fontSize: 11 }}>{o.limit_price ?? "—"} · SL {o.stop ?? "—"} · TP {o.target ?? "—"}{o.rr ? ` · ${num(o.rr, 1)}R` : ""}{o.risk_usd ? ` · risk ${money(o.risk_usd)}` : ""}</div>
                  {o.pnl !== null && <div className={`mono ${o.pnl >= 0 ? "up" : "down"}`} style={{ fontSize: 12.5 }}>{money(o.pnl)} · {o.fill_price} → {o.exit_price}</div>}
                  {(o.reasons?.length > 0 || o.error) && <div className="faint" style={{ fontSize: 11 }}>{o.error ?? o.reasons.join(" · ")}</div>}
                  <div className="faint" style={{ fontSize: 10.5 }}>{o.meta?.strategy ?? o.candidate_key} · {o.mode} · {new Date(o.created_at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>
    </>
  );
}
