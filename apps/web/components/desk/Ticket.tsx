"use client";

import { useMemo, useState } from "react";
import { clientOrderId, costInR, sizePosition, type GateResult, type InstrumentDef } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { staffPost } from "@/lib/market";
import { drawdown, ownerOf, rooms } from "@/lib/accounts";
import type { Investor, TradingAccount } from "@/lib/types";
import { money, num, toNum } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, Toggle } from "@/components/ui";

/**
 * Order & risk: size one plan for each selected account on its own equity and risk %,
 * with the guard that can shrink (loss-limit room, equity throttle) but never enlarge.
 * Orders are queued as PAPER in paper mode, or as manual tickets in LIVE mode until
 * venue adapters ship.
 */
export default function Ticket({ def, side, plan, suggest, targets = [], minRR = 2, gate, window, accounts, investors, onPlan, onDone }: {
  def: InstrumentDef;
  side: "long" | "short";
  plan: { entry: number; stop: number; target: number } | null;
  suggest: { entry: number; stop: number; target: number; targetLabel: string; stopAnchor: string; stopBuffer: number } | null;
  /** Real levels beyond the engine entry with the R each pays. */
  targets?: { level: number; label: string; r: number }[];
  minRR?: number;
  gate: GateResult | null;
  window: string | null;
  accounts: TradingAccount[];
  investors: Investor[];
  onPlan: (p: { entry: string; stop: string; target: string }) => void;
  onDone: (msg: string) => void;
}) {
  const me = useMe();
  const [form, setForm] = useState({ entry: "", stop: "", target: "" });
  const [risk, setRisk] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [telegram, setTelegram] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pool = accounts.filter((a) => a.active && a.currency !== "INR" && (!a.instruments?.length || a.instruments.includes(def.id)));
  const selected = picked ?? new Set(pool.filter((a) => !a.investor_id || a.type === "investor").slice(0, 3).map((a) => a.id));
  const riskPct = toNum(risk) || 0.5;
  const set = (k: keyof typeof form, v: string) => { const f = { ...form, [k]: v }; setForm(f); onPlan(f); };

  const rows = useMemo(() => pool.filter((a) => selected.has(a.id)).map((a) => {
    if (!plan) return { a, size: 0, risk: 0, notes: [] as string[], below: true };
    const eq = Number(a.equity) || Number(a.balance);
    let pct = riskPct;
    const notes: string[] = [];
    if (me.settings?.equity_throttle !== false && drawdown(a) > 0.03) { pct /= 2; notes.push("throttled ½ (>3% below peak)"); }
    const r = rooms(a);
    const budget = (eq * pct) / 100;
    const caps = [budget];
    const buffer = me.settings?.prop_buffer === false ? 1 : 0.5;
    if (r.dailyLossRoom !== undefined) caps.push(r.dailyLossRoom * buffer);
    if (r.maxLossRoom !== undefined) caps.push(r.maxLossRoom * buffer);
    const allowed = Math.max(0, Math.min(...caps));
    if (allowed < budget - 1e-9) notes.push(`cut to ${money(allowed)} by loss-limit room`);
    const s = sizePosition(def, { balance: eq, riskPct: (allowed / eq) * 100, entry: plan.entry, stop: plan.stop });
    if (s.belowMinimum) notes.push("below minimum size");
    return { a, size: s.size, risk: s.riskAmount, notes, below: s.belowMinimum };
  }), [pool, selected, plan, riskPct, def, me.settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const rr = plan ? Math.abs(plan.target - plan.entry) / Math.abs(plan.entry - plan.stop) : null;
  const cost = plan ? costInR(def, plan.entry, plan.stop) : null;
  const stopPct = plan ? (Math.abs(plan.entry - plan.stop) / plan.entry) * 100 : null;
  const tradeable = !!gate && !gate.blockers.length && (gate.grade === "A+" || gate.grade === "A");

  const place = async () => {
    if (!plan || !gate) return;
    if (me.settings?.kill_switch) return setErr("Kill switch is on");
    setBusy(true); setErr(null);
    const sig = await supabase.from("signals").insert({
      instrument: def.id, side, model: gate.model, session_window: window, entry: plan.entry, stop: plan.stop, target: plan.target,
      rr: gate.rr, grade: gate.grade, gate: gate.boxes, state: "ARMED", edge_version: "3.0", source: "manual",
    }).select("id").single();
    if (sig.error) { setBusy(false); return setErr(sig.error.message); }
    const paper = me.settings?.mode !== "LIVE";
    const orders = rows.filter((r) => !r.below).map((r) => ({
      signal_id: sig.data.id, account_id: r.a.id, client_order_id: clientOrderId(sig.data.id, r.a.id), action: paper ? "PAPER" : "MANUAL", side,
      qty: r.size, entry: plan.entry, stop: plan.stop, target: plan.target, risk_amount: r.risk, reasons: r.notes, status: paper ? "queued" : "manual_pending",
    }));
    if (orders.length) {
      const o = await supabase.from("orders").upsert(orders, { onConflict: "client_order_id", ignoreDuplicates: true });
      if (o.error) { setBusy(false); return setErr(o.error.message); }
    }
    if (telegram) {
      const d = def.digits;
      await staffPost("/api/telegram", {
        kind: "ARMED", instrument: def.id,
        text: `${side === "long" ? "🟢" : "🔴"} <b>${def.id} · ${gate.grade}</b>\n${side === "long" ? "Long" : "Short"} limit ${num(plan.entry, d)} · SL ${num(plan.stop, d)} · TP ${num(plan.target, d)} · ${num(gate.rr ?? 0, 2)}R\nModel ${gate.model}${window ? ` · ${window === "ny_q" ? "NY Q" : "London Q"}` : ""} · ${orders.length} account${orders.length === 1 ? "" : "s"}`,
      }).catch((e: Error) => setErr(`Orders queued; Telegram failed: ${e.message}`));
    }
    setBusy(false);
    onDone(`${orders.length} ${paper ? "paper" : "manual"} order${orders.length === 1 ? "" : "s"} queued for ${def.id}`);
  };

  return (
    <Card title="Order & risk" right={<Chip>{def.kind.toUpperCase()} · limit {side}</Chip>}>
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 8 }}>
        {(["entry", "stop", "target"] as const).map((k) => (
          <label key={k} className="fld">
            <span style={{ textTransform: "capitalize" }}>{k}</span>
            <div className="inp"><input inputMode="decimal" value={form[k]} placeholder={suggest ? String(Number(suggest[k].toFixed(def.digits))) : ""} onChange={(e) => set(k, e.target.value)} /></div>
          </label>
        ))}
        <label className="fld"><span>Risk per account</span><div className="inp"><input inputMode="decimal" value={risk} placeholder="0.50" onChange={(e) => setRisk(e.target.value)} /><span className="u">%</span></div></label>
      </div>
      {suggest && (
        <div className="faint" style={{ marginTop: 6, fontSize: 12 }}>
          Engine stop: {side === "long" ? "below" : "above"} {suggest.stopAnchor} + {num(suggest.stopBuffer, def.digits)} buffer (0.2 × 5M ATR)
        </div>
      )}
      {targets.length > 0 && (
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <span className="lbl">Targets</span>
          {targets.slice(0, 6).map((t) => (
            <button key={`${t.label}${t.level}`} type="button" className={`chip ${t.r >= minRR ? "up" : ""}`} title={`Use ${t.label} as target`} onClick={() => set("target", String(Number(t.level.toFixed(def.digits))))}>
              {num(t.level, def.digits)} · {t.label} · {t.r.toFixed(1)}R
            </button>
          ))}
        </div>
      )}
      {suggest && (form.entry || form.stop || form.target) && <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => { setForm({ entry: "", stop: "", target: "" }); onPlan({ entry: "", stop: "", target: "" }); }}>Use engine plan ({suggest.targetLabel})</button>}
      {plan && (
        <div className="px" style={{ marginTop: 10 }}>
          <div><span className="lbl">R:R</span><b className={`mono ${rr !== null && rr >= minRR ? "up" : "down"}`}>{rr !== null ? rr.toFixed(2) : "—"}</b></div>
          <div><span className="lbl">Stop</span><b className={`mono ${def.minStopPct && stopPct !== null && stopPct < def.minStopPct ? "down" : ""}`}>{stopPct !== null ? `${stopPct.toFixed(2)}%` : "—"}</b></div>
          <div><span className="lbl">Cost</span><b className="mono">{cost !== null ? `${cost.toFixed(2)}R` : "—"}</b></div>
          <div><span className="lbl">Net R at TP</span><b className="mono acc">{rr !== null && cost !== null ? (rr - cost).toFixed(2) : "—"}</b></div>
        </div>
      )}
      <div className="lbl-u" style={{ margin: "12px 0 4px" }}>Accounts · sized on own equity</div>
      {pool.length === 0 ? <Empty>No active accounts trade {def.id}. Add one in Accounts.</Empty> : pool.map((a) => {
        const r = rows.find((x) => x.a.id === a.id);
        const on = selected.has(a.id);
        const owner = ownerOf(a, investors);
        return (
          <button key={a.id} type="button" onClick={() => { const n = new Set(selected); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); setPicked(n); }}
            style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 12, width: "100%", background: "none", border: 0, borderBlockEnd: "1px solid var(--line)", textAlign: "left", opacity: on ? 1 : 0.45 }}>
            <span className="col" style={{ gap: 1, minWidth: 0 }}>
              <b style={{ fontWeight: 500 }}>{a.name} <Chip tone={owner.own ? "acc" : "info"}>{owner.label}</Chip></b>
              <span className="faint mono" style={{ fontSize: 11 }}>{money(Number(a.equity), a.currency)}{r && on ? ` · risk ${money(r.risk)}${r.notes.length ? ` · ${r.notes[0]}` : ""}` : ""}</span>
            </span>
            <span className="mono">{r && on ? `${num(r.size, def.sizing.kind === "cfd" ? 2 : 3)} ${def.sizing.unit}` : "—"}</span>
            <span className={`dot ${on ? "acc" : ""}`} style={{ color: on ? "var(--accent)" : "var(--line-2)" }} />
          </button>
        );
      })}
      <div className="between" style={{ marginTop: 10 }}><span style={{ fontSize: 12.5 }}>Send Telegram alert</span><Toggle on={telegram} onChange={setTelegram} label="Send Telegram alert" /></div>
      {err && <p className="down" style={{ fontSize: 12, marginTop: 6 }}>{err}</p>}
      <button className={`btn ${side === "long" ? "buy" : "sell"} lg block`} style={{ marginTop: 12 }} disabled={!plan || !tradeable || busy || !!me.settings?.kill_switch || !rows.some((r) => !r.below)} onClick={place}>
        {busy ? "Queuing…" : plan ? `${me.settings?.mode === "LIVE" ? "Queue manual" : "Paper"} ${side === "long" ? "buy" : "sell"} limit · ${num(plan.entry, def.digits)}` : "No plan yet"}
      </button>
      <p className="faint" style={{ fontSize: 11, marginTop: 6 }}>{!tradeable ? "Enabled only when the gate grades A+ (or A at base risk). " : ""}{me.settings?.mode === "LIVE" ? "LIVE: orders become manual tickets to execute on each account." : "PAPER: the autopilot fills and closes these against live candles."}</p>
    </Card>
  );
}
