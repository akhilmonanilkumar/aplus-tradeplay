"use client";

import { useState } from "react";
import { LIVE_INSTRUMENT_IDS as INSTRUMENT_IDS } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { drawdown, matchesOwner, ownerOf, ownerOptions } from "@/lib/accounts";
import { istDay, todayIst } from "@/lib/derive";
import type { AccountType, CashFlow, CopyPolicy, Investor, Order, Signal, Snapshot, Trade, TradingAccount } from "@/lib/types";
import { dateShort, money, num, pct, signed, toNum } from "@/lib/fmt";
import { Chip, Empty, ErrorNote, Seg, Spark, Table, Toggle } from "@/components/ui";

const TYPES: AccountType[] = ["master", "sub", "eval", "demo", "investor"];
const POLICIES: CopyPolicy[] = ["PAPER", "MANUAL", "CONFIRM", "AUTO", "BLOCKED"];
const VENUES = ["The5ers", "FundedHive", "FundedIN", "Breakout", "Binance", "Bybit", "OKX", "Delta Exchange India", "CoinSwitch", "Coinbase", "OANDA", "cTrader broker", "MT5 broker", "Other"];
const POL_TONE: Record<string, "up" | "info" | "warn" | "down" | ""> = { AUTO: "up", CONFIRM: "info", MANUAL: "warn", PAPER: "", BLOCKED: "down" };
const FLOW_SIGN: Record<CashFlow["kind"], 1 | -1 | 0> = { deposit: 1, withdrawal: -1, payout: -1, fee: -1, adjustment: 0 };

type Rules = { daily_loss_pct?: number; max_loss_pct?: number; profit_target_pct?: number; split?: number };

function InstrumentPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="row" style={{ gap: 6 }}>
      {INSTRUMENT_IDS.map((i) => <button key={i} type="button" className={`chip ${value.includes(i) ? "acc" : ""}`} onClick={() => onChange(value.includes(i) ? value.filter((x) => x !== i) : [...value, i])}>{i}</button>)}
    </div>
  );
}

function AddAccount({ investors, onDone, onClose }: { investors: Investor[]; onDone: () => void; onClose: () => void }) {
  const [f, setF] = useState({ name: "", type: "sub" as AccountType, venue: "Binance", investor_id: "", currency: "USD", start: "", risk: "0.5", policy: "PAPER" as CopyPolicy, daily: "", max: "", target: "", split: "", broker: "" });
  const [inst, setInst] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value, ...(k === "investor_id" && e.target.value ? { type: "investor" as AccountType } : {}) });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const start = toNum(f.start);
    if (!f.name.trim() || !(start > 0)) return setErr("Name and a positive balance are required");
    if (f.type === "investor" && !f.investor_id) return setErr("Investor accounts need an investor");
    const rules: Rules = {};
    if (f.daily) rules.daily_loss_pct = toNum(f.daily);
    if (f.max) rules.max_loss_pct = toNum(f.max);
    if (f.target) rules.profit_target_pct = toNum(f.target);
    if (f.split) rules.split = toNum(f.split) / 100;
    const { data, error } = await supabase.from("trading_accounts").insert({ name: f.name.trim(), type: f.type, venue: f.venue, investor_id: f.investor_id || null, currency: f.currency, start_balance: start, balance: start, equity: start, hwm: start, risk_pct: toNum(f.risk), copy_policy: f.policy, firm_rules: rules, instruments: inst, broker_account: f.broker || null }).select("id").single();
    if (error) return setErr(error.message);
    await supabase.from("cash_flows").insert({ account_id: data.id, kind: "deposit", amount: start, note: "Opening balance" });
    onDone();
  };
  const sel = (k: keyof typeof f, opts: readonly string[]) => <div className="inp"><select value={f[k]} onChange={set(k)}>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select></div>;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="New account">
      <form className="card" onSubmit={submit}>
        <div className="ch"><h3>New account</h3><span className="sp" /><button type="button" className="btn ghost sm" onClick={onClose}>Close</button></div>
        <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
          <label className="fld"><span>Name</span><div className="inp txt"><input value={f.name} onChange={set("name")} /></div></label>
          <label className="fld"><span>Owner</span><div className="inp"><select value={f.investor_id} onChange={set("investor_id")}><option value="">Own (firm)</option>{investors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div></label>
          <label className="fld"><span>Type</span>{sel("type", TYPES)}</label>
          <label className="fld"><span>Venue</span>{sel("venue", VENUES)}</label>
          <label className="fld"><span>Login / account no.</span><div className="inp"><input value={f.broker} onChange={set("broker")} /></div></label>
          <label className="fld"><span>Currency</span>{sel("currency", ["USD", "USDT"])}</label>
          <label className="fld"><span>Opening balance</span><div className="inp"><input inputMode="decimal" value={f.start} onChange={set("start")} /></div></label>
          <label className="fld"><span>Risk per trade</span><div className="inp"><input inputMode="decimal" value={f.risk} onChange={set("risk")} /><span className="u">%</span></div></label>
          <label className="fld"><span>Execution</span>{sel("policy", POLICIES)}</label>
          <label className="fld"><span>Daily loss limit</span><div className="inp"><input inputMode="decimal" value={f.daily} onChange={set("daily")} /><span className="u">%</span></div></label>
          <label className="fld"><span>Max loss</span><div className="inp"><input inputMode="decimal" value={f.max} onChange={set("max")} /><span className="u">%</span></div></label>
          <label className="fld"><span>Profit target</span><div className="inp"><input inputMode="decimal" value={f.target} onChange={set("target")} /><span className="u">%</span></div></label>
        </div>
        <div className="lbl-u" style={{ margin: "12px 0 6px" }}>Instruments traded (none = all)</div>
        <InstrumentPicker value={inst} onChange={setInst} />
        {err && <p className="down" style={{ fontSize: 12.5, marginTop: 8 }}>{err}</p>}
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}><button className="btn pri">Add account</button></div>
      </form>
    </div>
  );
}

function Detail({ a, investors, flows, snaps, onSaved }: { a: TradingAccount; investors: Investor[]; flows: CashFlow[]; snaps: Snapshot[]; onSaved: () => void }) {
  const r = (a.firm_rules ?? {}) as Rules;
  const [v, setV] = useState({ risk: String(a.risk_pct), daily: String(r.daily_loss_pct ?? ""), max: String(r.max_loss_pct ?? ""), bal: String(a.balance), eq: String(a.equity), owner: a.investor_id ?? "", notes: a.notes ?? "" });
  const [inst, setInst] = useState<string[]>(a.instruments ?? []);
  const [flow, setFlow] = useState({ kind: "deposit" as CashFlow["kind"], amount: "", note: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const owner = ownerOf(a, investors);
  const myFlows = flows.filter((f) => f.account_id === a.id);
  const netDeposits = myFlows.reduce((s, f) => s + FLOW_SIGN[f.kind] * Number(f.amount), 0);
  const growth = netDeposits > 0 ? (Number(a.equity) - netDeposits) / netDeposits : null;
  const curve = snaps.filter((s) => s.account_id === a.id).map((s) => Number(s.equity));

  const save = async () => {
    const eq = toNum(v.eq), bal = toNum(v.bal);
    const patch = {
      risk_pct: toNum(v.risk), balance: bal, equity: eq, hwm: Math.max(Number(a.hwm ?? 0), eq), instruments: inst, notes: v.notes || null,
      investor_id: v.owner || null, type: v.owner ? "investor" : a.type === "investor" ? "sub" : a.type,
      firm_rules: { ...r, daily_loss_pct: v.daily ? toNum(v.daily) : undefined, max_loss_pct: v.max ? toNum(v.max) : undefined },
    };
    const { error } = await supabase.from("trading_accounts").update(patch).eq("id", a.id);
    setMsg(error ? error.message : "Saved — balance change recorded in the growth log");
    if (!error) onSaved();
  };
  const addFlow = async () => {
    const amt = toNum(flow.amount);
    if (!(amt > 0)) return setMsg("Enter a positive amount");
    const { error } = await supabase.from("cash_flows").insert({ account_id: a.id, kind: flow.kind, amount: amt, note: flow.note || null });
    if (error) return setMsg(error.message);
    // Deposits / withdrawals move the balance too (fees and payouts already left the account).
    const sign = flow.kind === "deposit" ? 1 : flow.kind === "withdrawal" ? -1 : 0;
    if (sign) await supabase.from("trading_accounts").update({ balance: Number(a.balance) + sign * amt, equity: Number(a.equity) + sign * amt }).eq("id", a.id);
    setFlow({ kind: "deposit", amount: "", note: "" });
    setMsg(`${flow.kind} recorded`);
    onSaved();
  };
  const fld = (k: "risk" | "daily" | "max" | "bal" | "eq", label: string, unit?: string) => <label className="fld"><span>{label}</span><div className="inp"><input inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />{unit && <span className="u">{unit}</span>}</div></label>;
  return (
    <div className="card s4">
      <div className="ch"><h3>{a.name}</h3><span className="sp" /><Chip tone={owner.own ? "acc" : "info"}>{owner.label}</Chip></div>
      <span className="faint" style={{ fontSize: 12 }}>{a.venue} · {a.type}{a.broker_account ? ` · ${a.broker_account}` : ""}</span>
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 8, marginTop: 10 }}>
        <div><div className="lbl">Net deposits</div><b className="mono">{money(netDeposits, a.currency, 0)}</b></div>
        <div><div className="lbl">Growth</div><b className={`mono ${growth !== null ? signed(growth) : ""}`}>{growth !== null ? `${growth >= 0 ? "+" : ""}${pct(growth, 2)}` : "—"}</b></div>
        <div><div className="lbl">From peak</div><b className="mono">{pct(-drawdown(a), 1)}</b></div>
      </div>
      {curve.length > 1 && <div style={{ marginTop: 8 }}><Spark values={curve} height={70} /></div>}
      <label className="fld" style={{ marginTop: 10 }}><span>Owner</span><div className="inp"><select value={v.owner} onChange={(e) => setV({ ...v, owner: e.target.value })}><option value="">Own (firm)</option>{investors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div></label>
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 8 }}>
        {fld("bal", "Balance")}{fld("eq", "Equity")}{fld("risk", "Risk per trade", "%")}{fld("daily", "Daily loss stop", "%")}{fld("max", "Max loss", "%")}
      </div>
      <div className="lbl-u" style={{ margin: "12px 0 6px" }}>Instruments</div>
      <InstrumentPicker value={inst} onChange={setInst} />
      <label className="fld" style={{ marginTop: 10 }}><span>Notes</span><textarea className="inp" style={{ minHeight: 56 }} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></label>
      <div className="row" style={{ marginTop: 10 }}>
        <select className="chip" aria-label="Execution" value={a.copy_policy} onChange={async (e) => { await supabase.from("trading_accounts").update({ copy_policy: e.target.value }).eq("id", a.id); onSaved(); }}>{POLICIES.map((p) => <option key={p}>{p}</option>)}</select>
        <span style={{ flex: 1 }} />
        <button className="btn pri sm" onClick={save}>Save</button>
      </div>

      <div className="lbl-u" style={{ margin: "16px 0 6px" }}>Money in / out</div>
      <div className="row">
        <div className="inp" style={{ width: 120 }}><select aria-label="Kind" value={flow.kind} onChange={(e) => setFlow({ ...flow, kind: e.target.value as CashFlow["kind"] })}>{(["deposit", "withdrawal", "payout", "fee", "adjustment"] as const).map((k) => <option key={k}>{k}</option>)}</select></div>
        <div className="inp" style={{ width: 110 }}><input inputMode="decimal" placeholder="Amount" aria-label="Amount" value={flow.amount} onChange={(e) => setFlow({ ...flow, amount: e.target.value })} /></div>
        <div className="inp txt" style={{ flex: 1, minWidth: 90 }}><input placeholder="Note" aria-label="Note" value={flow.note} onChange={(e) => setFlow({ ...flow, note: e.target.value })} /></div>
        <button className="btn sm" onClick={addFlow}>Add</button>
      </div>
      {myFlows.slice(0, 6).map((f) => (
        <div key={f.id} className="between" style={{ fontSize: 12, padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
          <span>{dateShort(f.at)} · {f.kind}{f.note ? <span className="faint"> · {f.note}</span> : null}</span>
          <span className={`mono ${FLOW_SIGN[f.kind] > 0 ? "up" : FLOW_SIGN[f.kind] < 0 ? "down" : ""}`}>{FLOW_SIGN[f.kind] > 0 ? "+" : FLOW_SIGN[f.kind] < 0 ? "−" : ""}{money(Number(f.amount), a.currency)}</span>
        </div>
      ))}
      {msg && <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>{msg}</p>}
    </div>
  );
}

export default function Accounts() {
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const investors = useRows<Investor>({ table: "investors", order: "name", ascending: true });
  const orders = useRows<Order>({ table: "orders", order: "created_at", limit: 200 });
  const signals = useRows<Signal>({ table: "signals", select: "id,instrument,side,created_at", order: "created_at", limit: 200 });
  const trades = useRows<Trade>({ table: "trades", select: "id,account_id,pnl,closed_at,source", order: "closed_at", limit: 5000 });
  const flows = useRows<CashFlow>({ table: "cash_flows", order: "at", limit: 5000 });
  const snaps = useRows<Snapshot>({ table: "account_snapshots", order: "at", ascending: true, limit: 10000 });
  const [owner, setOwner] = useState("all");
  const [type, setType] = useState<"all" | AccountType>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const invs = investors.rows ?? [];
  const acc = accounts.rows ?? [];
  const name = (id: string) => acc.find((a) => a.id === id)?.name ?? "—";
  const ord = orders.rows ?? [];
  const month = todayIst().slice(0, 7);
  const pnlFor = (id: string, f: (d: string) => boolean) => (trades.rows ?? []).filter((t) => t.account_id === id && t.closed_at && t.source !== "paper" && f(istDay(t.closed_at))).reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const rows = acc.filter((a) => matchesOwner(a, owner) && (type === "all" || a.type === type));
  const selected = acc.find((a) => a.id === sel) ?? rows[0] ?? null;
  const total = rows.filter((a) => a.active && a.currency !== "INR").reduce((s, a) => s + Number(a.equity), 0);
  const reload = () => { accounts.reload(); flows.reload(); snaps.reload(); };

  return (
    <>
      <ErrorNote error={accounts.error || orders.error} />
      <section className="g12">
        <div className="card s3"><div className="lbl">Equity · filtered</div><div className="kv" style={{ marginTop: 6 }}>{money(total, "USD", 0)}</div><div className="faint" style={{ fontSize: 12 }}>{rows.filter((a) => a.active).length} active accounts</div></div>
        <div className="card s3"><div className="lbl">Own vs investors</div><div className="kv" style={{ marginTop: 6, fontSize: 18 }}>{acc.filter((a) => !a.investor_id).length} / {acc.filter((a) => a.investor_id).length}</div><div className="faint" style={{ fontSize: 12 }}>{invs.length} investors</div></div>
        <div className="card s3"><div className="lbl">Orders today</div><div className="kv" style={{ marginTop: 6 }}>{ord.filter((o) => istDay(o.created_at) === todayIst()).length}</div><div className="faint" style={{ fontSize: 12 }}>{ord.filter((o) => istDay(o.created_at) === todayIst() && o.status === "filled").length} filled · {ord.filter((o) => istDay(o.created_at) === todayIst() && o.action === "BLOCK").length} blocked</div></div>
        <div className="card s3"><div className="lbl">Tickets waiting</div><div className={`kv ${ord.some((o) => o.status === "manual_pending" || o.status === "awaiting_confirm") ? "warn" : ""}`} style={{ marginTop: 6 }}>{ord.filter((o) => o.status === "manual_pending" || o.status === "awaiting_confirm").length}</div><div className="faint" style={{ fontSize: 12 }}>manual + confirm</div></div>
      </section>

      <section className="g12">
        <div className="card flush s8">
          <div className="ch" style={{ padding: "14px 16px 0" }}>
            <h3>Accounts</h3><span className="sp" />
            <div className="inp" style={{ width: 160, height: 30 }}><select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>{ownerOptions(invs).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>
            <Seg label="Type" value={type} onChange={setType} options={[{ v: "all", l: "All" }, { v: "master", l: "Master" }, { v: "sub", l: "Sub" }, { v: "eval", l: "Eval" }, { v: "demo", l: "Demo" }, { v: "investor", l: "Investor" }]} />
            <button className="btn pri sm" onClick={() => setAdding(true)}>Add account</button>
          </div>
          {rows.length === 0 ? <div style={{ padding: 16 }}><Empty>No accounts</Empty></div> : (
            <Table head={["Account", "Owner", "Equity", "Today", "MTD", "From peak", "Pairs", "Exec", "Active"]} right={[2, 3, 4, 5]}>
              {rows.map((a) => {
                const t = pnlFor(a.id, (d) => d === todayIst()), m = pnlFor(a.id, (d) => d.startsWith(month));
                const o = ownerOf(a, invs);
                return (
                  <tr key={a.id} onClick={() => setSel(a.id)} style={{ cursor: "pointer", background: selected?.id === a.id ? "var(--accent-bg)" : undefined }}>
                    <td><div className="col" style={{ gap: 1 }}><b style={{ fontWeight: 500 }}>{a.name}</b><span className="faint" style={{ fontSize: 11 }}>{a.venue} · {a.type}</span></div></td>
                    <td><Chip tone={o.own ? "acc" : "info"}>{o.label}</Chip></td>
                    <td className="r mono">{money(Number(a.equity), a.currency)}</td>
                    <td className={`r mono ${signed(t)}`}>{t ? money(t, a.currency) : "—"}</td>
                    <td className={`r mono ${signed(m)}`}>{m ? money(m, a.currency) : "—"}</td>
                    <td className={`r mono ${drawdown(a) > 0.03 ? "down" : "faint"}`}>{pct(-drawdown(a), 1)}</td>
                    <td className="faint" style={{ fontSize: 11 }}>{a.instruments?.length ? a.instruments.join(", ") : "all"}</td>
                    <td><Chip tone={POL_TONE[a.copy_policy]}>{a.copy_policy}</Chip></td>
                    <td onClick={(e) => e.stopPropagation()}><Toggle on={a.active} onChange={async (val) => { await supabase.from("trading_accounts").update({ active: val }).eq("id", a.id); accounts.reload(); }} label={`Active: ${a.name}`} /></td>
                  </tr>
                );
              })}
            </Table>
          )}
        </div>
        {selected ? <Detail key={selected.id} a={selected} investors={invs} flows={flows.rows ?? []} snaps={snaps.rows ?? []} onSaved={reload} /> : <div className="card s4"><Empty>Select an account</Empty></div>}
      </section>

      <section className="card flush">
        <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Order log</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Desk tickets and autopilot orders</span></div>
        {ord.length === 0 ? <div style={{ padding: 16 }}><Empty>No orders yet</Empty></div> : (
          <Table head={["Time (IST)", "Signal", "Account", "Owner", "Qty", "Entry", "Fill", "Status"]} right={[4, 5, 6]}>
            {ord.slice(0, 60).map((o) => {
              const s = (signals.rows ?? []).find((x) => x.id === o.signal_id);
              const a = acc.find((x) => x.id === o.account_id);
              const tone = o.status === "filled" ? "up" : o.status === "blocked" || o.status === "rejected" ? "down" : o.status.includes("pending") || o.status.includes("confirm") ? "warn" : "";
              return (
                <tr key={o.id}>
                  <td className="mono faint">{new Date(o.created_at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{s ? `${s.instrument} ${s.side}` : `manual ${o.side}`}</td>
                  <td>{name(o.account_id)}</td>
                  <td>{a ? ownerOf(a, invs).label : "—"}</td>
                  <td className="r mono">{num(Number(o.qty), 3)}</td>
                  <td className="r mono">{num(Number(o.entry), 2)}</td>
                  <td className="r mono">{o.fill_price !== null ? num(Number(o.fill_price), 2) : "—"}</td>
                  <td><Chip tone={tone as "up" | "down" | "warn" | ""}>{o.action === "PAPER" ? "paper · " : ""}{o.status.replace(/_/g, " ")}</Chip></td>
                </tr>
              );
            })}
          </Table>
        )}
      </section>
      {adding && <AddAccount investors={invs} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </>
  );
}
