"use client";

import { useMemo, useState } from "react";
import {
  BTCUSDT_PERP_DEFAULT, MCX_MULTIPLIER, XAUUSD_DEFAULT, breakevenWinRate, clientOrderId, rewardToRisk, sizeCfd, sizeMcx, sizePerp,
} from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { eligible, plan as planCopy } from "@/lib/copy";
import type { TradingAccount } from "@/lib/types";
import { money, num, pct, toNum } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Chip, Empty, ErrorNote, Note, Table } from "@/components/ui";

type Inst = "XAUUSD" | "BTCUSDT.P" | "GOLD" | "GOLDM";
const DEF: Record<Inst, { bal: string; risk: string; en: string; sl: string; tp: string; x1: string }> = {
  XAUUSD: { bal: "10000", risk: "0.5", en: "4120.60", sl: "4105.60", tp: "4171.40", x1: "0" },
  "BTCUSDT.P": { bal: "10000", risk: "0.5", en: "68000", sl: "67500", tp: "69600", x1: "10" },
  GOLD: { bal: "2500000", risk: "0.5", en: "118400", sl: "118250", tp: "118900", x1: "250" },
  GOLDM: { bal: "500000", risk: "0.5", en: "118400", sl: "118250", tp: "118900", x1: "60" },
};
const Out = ({ k, v, n, tone = "", big = false }: { k: string; v: string; n?: string; tone?: string; big?: boolean }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: 12, borderRadius: 14, background: big ? "var(--accent-bg)" : "var(--surface-2)", border: `1px solid ${big ? "var(--accent)" : "var(--line)"}`, gridColumn: big ? "1 / -1" : undefined }}>
    <span className="lbl">{k}</span>
    <b className={big ? "kv lg acc" : `mono ${tone}`} style={big ? undefined : { fontSize: 16 }}>{v}</b>
    {n && <span className="faint" style={{ fontSize: 11 }}>{n}</span>}
  </div>
);

function calc(inst: Inst, v: typeof DEF.XAUUSD) {
  const bal = toNum(v.bal), risk = toNum(v.risk), en = toNum(v.en), sl = toNum(v.sl), tp = toNum(v.tp), x1 = toNum(v.x1);
  const dist = Math.abs(en - sl);
  const rr = tp > 0 ? rewardToRisk(en, sl, tp) : null;
  const ccy = inst === "GOLD" || inst === "GOLDM" ? "INR" : "USD";
  if (inst === "XAUUSD") {
    const spec = { ...XAUUSD_DEFAULT, commissionPerLot: x1 || 0 };
    const s = sizeCfd({ balance: bal, riskPct: risk, entry: en, stop: sl, spec });
    const reward = s.lots * ((Math.abs(tp - en) / spec.tickSize) * spec.tickValue - (x1 || 0));
    return {
      ccy, rr, dist, size: `${num(s.lots, 2)} lots`, sizeNote: `raw ${num(s.rawLots, 4)} · floored to 0.01`, riskAmt: s.riskAmount, reward, below: s.belowMinimum,
      spec: [{ k: "Tick size", v: "0.01" }, { k: "Tick value / lot", v: "$1.00" }, { k: "Lot step", v: "0.01" }],
      formula: ["lots = risk ÷ (distance ÷ tick × tick value + commission)", `= ${money(s.riskBudget)} ÷ ${money(s.lossPerLot)} per lot`],
      extra: [{ k: "Loss per lot", v: money(s.lossPerLot), n: "incl. commission" }, { k: "Break-even win rate", v: rr ? pct(breakevenWinRate(rr), 1) : "—", n: "at this R:R" }],
      checks: [] as { ok: boolean; t: string }[], netR: rr,
    };
  }
  if (inst === "BTCUSDT.P") {
    const s = sizePerp({ balance: bal, riskPct: risk, entry: en, stop: sl, target: tp, leverage: x1 || 1, spec: BTCUSDT_PERP_DEFAULT });
    const reward = s.netRAtTarget !== null ? s.netRAtTarget * s.lossAtStop : 0;
    return {
      ccy, rr, dist, size: `${num(s.qty, 3)} BTC`, sizeNote: `raw ${num(s.rawQty, 5)} · step 0.001 · notional ${money(s.notional, "USD", 0)}`, riskAmt: s.lossAtStop, reward, below: s.belowMinimum,
      spec: [{ k: "Qty step", v: "0.001" }, { k: "Taker fee", v: "0.05%" }, { k: "Maint. margin", v: "0.40%" }],
      formula: ["qty = risk ÷ (|entry − stop| + fees)", "LP = (WB + cum − s·q·E) ÷ (q·MMR − s·q)", "net R = (reward − fees) ÷ loss at stop"],
      extra: [
        { k: "Fees to stop", v: `${num(s.feeR, 3)}R`, n: money(s.feesToStop) },
        { k: "Net R at TP", v: s.netRAtTarget !== null ? `${num(s.netRAtTarget, 3)}R` : "—", n: "after entry + exit fees" },
        { k: "Liquidation", v: num(s.liquidationPrice, 1), n: s.liquidationBeyondStop ? "beyond stop" : "INSIDE stop" },
        { k: "Margin", v: money(s.margin), n: `${num(x1, 0)}× isolated` },
      ],
      checks: [{ ok: s.stopPct >= 0.4, t: `Stop ${num(s.stopPct, 3)}% ≥ 0.40% of price` }, { ok: s.liquidationBeyondStop, t: "Liquidation beyond stop" }],
      netR: s.netRAtTarget,
    };
  }
  const mult = MCX_MULTIPLIER[inst];
  const s = sizeMcx({ capital: bal, riskPct: risk, entry: en, stop: sl, multiplier: mult, chargesPerLot: x1 || 0 });
  const reward = s.lots * (Math.abs(tp - en) * mult - (x1 || 0));
  return {
    ccy, rr, dist, size: `${s.lots} lot${s.lots === 1 ? "" : "s"}`, sizeNote: `raw ${num(s.rawLots, 3)} · whole lots`, riskAmt: s.riskAmount, reward, below: s.belowMinimum,
    spec: [{ k: "Contract", v: inst === "GOLD" ? "1 kg" : "100 g" }, { k: "₹ per ₹1 move", v: `₹${mult}` }, { k: "Lot step", v: "1" }],
    formula: ["lots = risk ÷ (distance × multiplier + charges)", `= ${money(s.riskBudget, "INR")} ÷ ${money(s.lossPerLot, "INR")} per lot`],
    extra: [{ k: "Loss per lot", v: money(s.lossPerLot, "INR"), n: "incl. charges" }, { k: "Break-even win rate", v: rr ? pct(breakevenWinRate(rr), 1) : "—", n: "at this R:R" }],
    checks: [] as { ok: boolean; t: string }[], netR: rr,
  };
}

export default function Orders() {
  const me = useMe();
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const [inst, setInst] = useState<Inst>("XAUUSD");
  const [vals, setVals] = useState(DEF);
  const [type, setType] = useState<"market" | "limit" | "stop">("limit");
  const [side, setSide] = useState<"long" | "short">("long");
  const [route, setRoute] = useState<"master" | "selected" | "all">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [review, setReview] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const v = vals[inst];
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setVals({ ...vals, [inst]: { ...v, [k]: e.target.value } });

  const c = useMemo(() => { try { return { ok: true as const, ...calc(inst, v) }; } catch (e) { return { ok: false as const, error: (e as Error).message }; } }, [inst, v]);
  const sideFromPlan = toNum(v.sl) < toNum(v.en) ? "long" : "short";
  const sideOk = side === sideFromPlan;
  const checks = c.ok ? [
    { ok: (c.netR ?? 0) >= 3, t: `R:R ${c.netR !== null ? num(c.netR, 2) : "—"} ≥ 3 to a real target` },
    { ok: !c.below, t: "Size above venue minimum" },
    { ok: toNum(v.risk) <= 1, t: `Risk ${num(toNum(v.risk), 2)}% ≤ 1% guideline` },
    { ok: sideOk, t: `Stop on the ${side === "long" ? "long" : "short"} side of entry` },
    ...c.checks,
  ] : [];

  const pool = eligible(accounts.rows ?? []);
  const targets = inst === "GOLD" || inst === "GOLDM" ? [] : route === "master" ? pool.filter((a) => a.type === "master") : route === "selected" ? pool.filter((a) => picked.has(a.id)) : pool;
  const fan = c.ok && (inst === "XAUUSD" || inst === "BTCUSDT.P") ? planCopy(targets, inst, { entry: toNum(v.en), stop: toNum(v.sl), target: toNum(v.tp) }, undefined, me.settings) : { decisions: [], error: null };

  const placeOrders = async () => {
    setMsg(null);
    if (!me.settings) return;
    if (me.settings.kill_switch) return setMsg({ ok: false, t: "Kill switch is on" });
    const batch = crypto.randomUUID();
    const rows = fan.decisions.map((d) => {
      const action = me.settings!.mode === "PAPER" && d.action !== "BLOCK" ? "PAPER" : d.action;
      return { account_id: d.accountId, client_order_id: clientOrderId(batch, d.accountId), action, side, qty: d.size, entry: toNum(v.en), stop: toNum(v.sl), target: toNum(v.tp), risk_amount: d.riskAmount, reasons: [...d.reasons, `manual ${type}`], status: action === "BLOCK" ? "blocked" : action === "CONFIRM" ? "awaiting_confirm" : action === "MANUAL" ? "manual_pending" : "queued" };
    });
    const { error } = await supabase.from("orders").insert(rows);
    setReview(false);
    setMsg(error ? { ok: false, t: error.message } : { ok: true, t: `${rows.length} orders queued${me.settings.mode === "PAPER" ? " (paper)" : ""}` });
  };

  const x1 = inst === "XAUUSD" ? { l: "Commission / lot", u: "$" } : inst === "BTCUSDT.P" ? { l: "Leverage", u: "×" } : { l: "Charges / lot", u: "₹" };

  return (
    <>
      <ErrorNote error={accounts.error || (c.ok ? fan.error : null)} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="g12">
        <div className="card s4">
          <div className="ch"><h3>Order panel</h3><span className="sp" /><Chip tone="acc">{inst}</Chip></div>
          <div className="seg" role="group" aria-label="Order type" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", width: "100%" }}>
            {(["market", "limit", "stop"] as const).map((t) => <button key={t} type="button" className={type === t ? "on" : ""} onClick={() => setType(t)} style={{ textTransform: "capitalize" }}>{t}</button>)}
          </div>
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button className={`btn ${side === "long" ? "buy" : ""}`} onClick={() => setSide("long")}>Buy · long</button>
            <button className={`btn ${side === "short" ? "sell" : ""}`} onClick={() => setSide("short")}>Sell · short</button>
          </div>
          <div className="lbl-u" style={{ margin: "14px 0 6px" }}>Route</div>
          <div className="col" style={{ gap: 6 }}>
            {([["master", "Master only", pool.filter((a) => a.type === "master").map((a) => a.venue).join(" · ") || "—"], ["selected", "Selected accounts", `${picked.size} picked`], ["all", "All copy routes", `${pool.length} active`]] as const).map(([k, l, n]) => (
              <label key={k} className="between" style={{ fontSize: 12.5 }}><span className="row"><input type="radio" name="rt" checked={route === k} onChange={() => setRoute(k)} /> {l}</span><span className="faint">{n}</span></label>
            ))}
          </div>
          <div className="lbl-u" style={{ margin: "14px 0 4px" }}>Fan-out preview · each account&apos;s own risk %</div>
          {inst === "GOLD" || inst === "GOLDM" ? <Empty>MCX orders are placed at the broker</Empty> : (route === "selected" ? pool : targets).length === 0 ? <Empty>No accounts on this route</Empty> : (
            <Table head={["Account", "Qty", "Risk", "Policy"]} right={[1, 2]}>
              {(route === "selected" ? pool : targets).map((a) => {
                const d = fan.decisions.find((x) => x.accountId === a.id);
                return (
                  <tr key={a.id} onClick={() => { if (route !== "selected") return; const n = new Set(picked); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); setPicked(n); }} style={{ opacity: route === "selected" && !picked.has(a.id) ? 0.5 : 1, cursor: route === "selected" ? "pointer" : undefined }}>
                    <td>{a.name}</td>
                    <td className="r mono">{d ? num(d.size, inst === "BTCUSDT.P" ? 3 : 2) : "—"}</td>
                    <td className="r mono">{d ? money(d.riskAmount) : "—"}</td>
                    <td><Chip tone={d?.action === "BLOCK" ? "down" : a.copy_policy === "AUTO" ? "up" : a.copy_policy === "MANUAL" ? "warn" : ""}>{d?.action === "BLOCK" ? "BLOCK" : a.copy_policy}</Chip></td>
                  </tr>
                );
              })}
            </Table>
          )}
          {review ? (
            <div className="col" style={{ marginTop: 12, gap: 8 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>{type} {side} {inst} @ {v.en} · SL {v.sl} · TP {v.tp} → {fan.decisions.filter((d) => d.action !== "BLOCK").length} accounts{me.settings?.mode === "PAPER" ? " · paper" : ""}</span>
              <div className="row"><button className="btn" onClick={() => setReview(false)}>Back</button><button className={`btn ${side === "long" ? "buy" : "sell"}`} style={{ flex: 1 }} onClick={placeOrders}>Confirm</button></div>
            </div>
          ) : (
            <button className="btn pri lg block" style={{ marginTop: 12 }} disabled={!c.ok || !sideOk || fan.decisions.length === 0 || !!me.settings?.kill_switch} onClick={() => setReview(true)}>Review &amp; place</button>
          )}
        </div>

        <div className="card s8">
          <div className="ch"><h3>Position &amp; risk calculator</h3><span className="sp" />
            <div className="seg" role="group" aria-label="Instrument">
              {([["XAUUSD", "XAUUSD"], ["BTCUSDT.P", "BTCUSDT.P"], ["GOLD", "MCX GOLD"], ["GOLDM", "MCX GOLDM"]] as const).map(([k, l]) => <button key={k} type="button" className={inst === k ? "on" : ""} onClick={() => setInst(k)}>{l}</button>)}
            </div>
          </div>
          <div className="g12" style={{ gap: 12 }}>
            <div className="s6 col" style={{ gap: 10 }}>
              <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                <label className="fld"><span>Account balance</span><div className="inp"><input inputMode="decimal" value={v.bal} onChange={set("bal")} /><span className="u">{c.ok ? c.ccy : ""}</span></div></label>
                <label className="fld"><span>Risk per trade</span><div className="inp"><input inputMode="decimal" value={v.risk} onChange={set("risk")} /><span className="u">%</span></div></label>
                <label className="fld"><span>Entry</span><div className="inp"><input inputMode="decimal" value={v.en} onChange={set("en")} /></div></label>
                <label className="fld"><span>Stop loss</span><div className="inp"><input inputMode="decimal" value={v.sl} onChange={set("sl")} /></div></label>
                <label className="fld"><span>Take profit</span><div className="inp"><input inputMode="decimal" value={v.tp} onChange={set("tp")} /></div></label>
                <label className="fld"><span>{x1.l}</span><div className="inp"><input inputMode="decimal" value={v.x1} onChange={set("x1")} /><span className="u">{x1.u}</span></div></label>
              </div>
              {c.ok && (
                <>
                  <div className="lbl-u">Contract spec · {inst === "BTCUSDT.P" ? "Binance USDⓈ-M tier 1" : inst === "XAUUSD" ? "100 oz CFD" : "MCX"}</div>
                  <div className="auto-s" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>{c.spec.map((s) => <Out key={s.k} k={s.k} v={s.v} />)}</div>
                  <div className="mono" style={{ fontSize: 11.5, color: "var(--muted)", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 12, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="lbl-u" style={{ marginBottom: 2 }}>Formula</span>
                    {c.formula.map((f) => <span key={f}>{f}</span>)}
                  </div>
                </>
              )}
            </div>
            <div className="s6 col" style={{ gap: 10 }}>
              {!c.ok ? <p className="down" style={{ fontSize: 12.5 }}>{c.error}</p> : (
                <>
                  <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                    <Out big k="Position size" v={c.size} n={c.sizeNote} />
                    <Out k="Money at risk" v={money(c.riskAmt, c.ccy)} n={`${num(toNum(v.bal) ? (c.riskAmt / toNum(v.bal)) * 100 : 0, 3)}% of balance`} tone="down" />
                    <Out k="Reward at TP" v={money(c.reward, c.ccy)} n="net of costs" tone="up" />
                    <Out k="R:R (structural)" v={c.rr !== null ? num(c.rr, 2) : "—"} n="gross, to target" />
                    <Out k="Stop distance" v={num(c.dist, 2)} n={`${num((c.dist / toNum(v.en)) * 100, 3)}% of price`} />
                    {c.extra.map((e) => <Out key={e.k} k={e.k} v={e.v} n={e.n} />)}
                  </div>
                  <div className="card" style={{ padding: "10px 14px", background: "var(--surface-2)" }}>
                    {checks.map((k) => (
                      <div key={k.t} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "7px 0", borderBottom: "1px dashed var(--line)" }}>
                        <Chip tone={k.ok ? "up" : "down"}>{k.ok ? "✓" : "✕"}</Chip><span>{k.t}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
