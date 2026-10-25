"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { AccountType, CopyPolicy, Investor, TradingAccount } from "@/lib/types";
import { money, num, pct, signed, toNum } from "@/lib/fmt";
import { Badge, Card, Empty, ErrorNote, Field, Kpi, PageHead } from "@/components/ui";

const TYPES: AccountType[] = ["master", "sub", "eval", "demo", "investor"];
const POLICIES: CopyPolicy[] = ["AUTO", "CONFIRM", "MANUAL", "PAPER", "BLOCKED"];
const VENUES = ["The5ers", "FundedHive", "FundedIN", "Breakout", "Binance", "Delta", "CoinSwitch", "cTrader", "MT5", "MCX · Zerodha", "MCX · Dhan", "MCX · Groww", "TradingView paper"];

const blank = { name: "", type: "sub" as AccountType, venue: "The5ers", platform: "", investor_id: "", currency: "USD", start_balance: "", risk_pct: "0.5", copy_policy: "PAPER" as CopyPolicy, daily: "", max: "", target: "", split: "" };

function AddAccount({ investors, onDone }: { investors: Investor[]; onDone: () => void }) {
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const start = toNum(f.start_balance);
    if (!f.name.trim() || !Number.isFinite(start) || start <= 0) return setError("Name and a positive balance are required");
    const rules: Record<string, number> = {};
    for (const [k, v] of [["daily_loss_pct", f.daily], ["max_loss_pct", f.max], ["profit_target_pct", f.target], ["split", f.split]] as const) {
      const n = toNum(v);
      if (v && Number.isFinite(n)) rules[k] = k === "split" ? n / 100 : n;
    }
    setBusy(true);
    const { error } = await supabase.from("trading_accounts").insert({
      name: f.name.trim(), type: f.type, venue: f.venue, platform: f.platform || null,
      investor_id: f.investor_id || null, currency: f.currency, start_balance: start, balance: start, equity: start, hwm: start,
      risk_pct: toNum(f.risk_pct), copy_policy: f.copy_policy, firm_rules: rules,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setF(blank);
    onDone();
  };

  return (
    <Card title="New account">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name"><input className="input" value={f.name} onChange={set("name")} /></Field>
        <Field label="Type"><select className="input" value={f.type} onChange={set("type")}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Venue"><select className="input" value={f.venue} onChange={set("venue")}>{VENUES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Investor">
          <select className="input" value={f.investor_id} onChange={set("investor_id")}>
            <option value="">—</option>
            {investors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </Field>
        <Field label="Currency"><select className="input" value={f.currency} onChange={set("currency")}><option>USD</option><option>USDT</option><option>INR</option></select></Field>
        <Field label="Start balance"><input className="input num" inputMode="decimal" value={f.start_balance} onChange={set("start_balance")} /></Field>
        <Field label="Risk %"><input className="input num" inputMode="decimal" value={f.risk_pct} onChange={set("risk_pct")} /></Field>
        <Field label="Copy policy"><select className="input" value={f.copy_policy} onChange={set("copy_policy")}>{POLICIES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Daily loss %"><input className="input num" inputMode="decimal" value={f.daily} onChange={set("daily")} /></Field>
        <Field label="Max loss %"><input className="input num" inputMode="decimal" value={f.max} onChange={set("max")} /></Field>
        <Field label="Profit target %"><input className="input num" inputMode="decimal" value={f.target} onChange={set("target")} /></Field>
        <Field label="Payout split %"><input className="input num" inputMode="decimal" value={f.split} onChange={set("split")} /></Field>
        {error && <p className="text-sm text-down sm:col-span-2 lg:col-span-4">{error}</p>}
        <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
          <button className="btn-accent" disabled={busy || f.type === "investor" && !f.investor_id}>{busy ? "Saving…" : "Add account"}</button>
        </div>
      </form>
    </Card>
  );
}

function AccountCard({ a, investor, onChange }: { a: TradingAccount; investor?: Investor; onChange: () => void }) {
  const [edit, setEdit] = useState(false);
  const [bal, setBal] = useState(String(a.balance));
  const [eq, setEq] = useState(String(a.equity));
  const [err, setErr] = useState<string | null>(null);
  const pnl = Number(a.equity) - Number(a.start_balance);
  const rules = a.firm_rules ?? {};
  const targetAmt = rules.profit_target_pct ? (Number(a.start_balance) * rules.profit_target_pct) / 100 : null;
  const floor = rules.max_loss_pct ? Number(a.start_balance) * (1 - rules.max_loss_pct / 100) : null;

  const update = async (patch: Partial<TradingAccount>) => {
    const { error } = await supabase.from("trading_accounts").update(patch).eq("id", a.id);
    if (error) setErr(error.message);
    else { setErr(null); onChange(); }
  };

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{a.name}</div>
          <div className="text-xs text-mute">{a.venue}{investor ? ` · ${investor.name}` : ""}</div>
        </div>
        <Badge tone={a.type === "master" ? "accent" : a.type === "investor" ? "chart" : "mute"}>{a.type}</Badge>
      </div>
      <div className="num mt-4 text-2xl font-semibold">{money(Number(a.equity), a.currency)}</div>
      <div className={`num text-sm ${signed(pnl)}`}>{money(pnl, a.currency)} · {pct(pnl / Number(a.start_balance || 1), 2)}</div>
      {targetAmt !== null && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-mute"><span>Target</span><span className="num">{pct(Math.max(0, pnl) / targetAmt, 0)}</span></div>
          <div className="mt-1 h-1.5 rounded-full bg-raised"><div className="h-1.5 rounded-full bg-up" style={{ width: `${Math.min(100, Math.max(0, pnl / targetAmt) * 100)}%` }} /></div>
        </div>
      )}
      {floor !== null && <div className="mt-2 flex justify-between text-xs text-mute"><span>Loss floor</span><span className="num">{money(floor, a.currency)} · room {money(Number(a.equity) - floor, a.currency)}</span></div>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <select className="input" value={a.copy_policy} onChange={(e) => update({ copy_policy: e.target.value as CopyPolicy })} aria-label="Copy policy">
          {POLICIES.map((p) => <option key={p}>{p}</option>)}
        </select>
        <div className="flex items-center gap-1 rounded-xl bg-raised px-3 text-sm"><span className="text-mute">risk</span><span className="num ml-auto">{num(Number(a.risk_pct), 2)}%</span></div>
      </div>
      {edit ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <input className="input num" value={bal} onChange={(e) => setBal(e.target.value)} aria-label="Balance" />
          <input className="input num" value={eq} onChange={(e) => setEq(e.target.value)} aria-label="Equity" />
          <button className="btn-primary" onClick={async () => {
            const b = toNum(bal), q = toNum(eq);
            if (!Number.isFinite(b) || !Number.isFinite(q)) return setErr("Invalid number");
            await update({ balance: b, equity: q, hwm: Math.max(Number(a.hwm ?? 0), q) });
            setEdit(false);
          }}>Save</button>
          <button className="btn-ghost" onClick={() => setEdit(false)}>Cancel</button>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button className="btn-ghost flex-1" onClick={() => setEdit(true)}>Update balance</button>
          <button className="btn-ghost" onClick={() => update({ active: !a.active })}>{a.active ? "Pause" : "Resume"}</button>
        </div>
      )}
      {err && <p className="mt-2 text-xs text-down">{err}</p>}
    </div>
  );
}

export default function Accounts() {
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const investors = useRows<Investor>({ table: "investors", order: "name", ascending: true });
  const [adding, setAdding] = useState(false);
  const rows = accounts.rows ?? [];
  const usd = rows.filter((a) => a.currency !== "INR");
  const eq = usd.reduce((s, a) => s + Number(a.equity), 0);
  const pnl = usd.reduce((s, a) => s + Number(a.equity) - Number(a.start_balance), 0);

  return (
    <div>
      <PageHead title="Accounts" right={<button className="btn-accent" onClick={() => setAdding((v) => !v)}>{adding ? "Close" : "Add account"}</button>} />
      <ErrorNote error={accounts.error} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Kpi label="Accounts" value={rows.length} foot={`${rows.filter((a) => a.active).length} active`} />
        <Kpi label="Equity (USD)" value={money(eq)} />
        <Kpi label="P&L (USD)" value={money(pnl)} tone={signed(pnl)} />
      </div>
      {adding && <div className="mt-4"><AddAccount investors={investors.rows ?? []} onDone={() => { setAdding(false); accounts.reload(); }} /></div>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {rows.length === 0 && !adding && <div className="sm:col-span-2 xl:col-span-3"><Empty>No accounts yet</Empty></div>}
        {rows.map((a) => <AccountCard key={a.id} a={a} investor={(investors.rows ?? []).find((i) => i.id === a.investor_id)} onChange={accounts.reload} />)}
      </div>
    </div>
  );
}
