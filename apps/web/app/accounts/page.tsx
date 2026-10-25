"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { istDay, todayIst } from "@/lib/derive";
import type { AccountType, CopyPolicy, CopyRoute, Investor, Order, Signal, Trade, TradingAccount } from "@/lib/types";
import { money, num, pct, signed, toNum } from "@/lib/fmt";
import { Chip, Empty, ErrorNote, Note, Seg, Table, Toggle } from "@/components/ui";

const TYPES: AccountType[] = ["master", "sub", "eval", "demo", "investor"];
const POLICIES: CopyPolicy[] = ["AUTO", "CONFIRM", "MANUAL", "PAPER", "BLOCKED"];
const VENUES = ["The5ers", "FundedHive", "FundedIN", "Breakout", "Binance", "Delta Exchange India", "CoinSwitch", "cTrader", "MT5", "Zerodha (MCX)", "Dhan (MCX)", "Groww (MCX)", "TradingView paper"];
/** Default copy rule per firm from the research brief — editable per account. */
const COPY_RULE_DEFAULT: Record<string, string> = { FundedHive: "banned", The5ers: "own_only", Breakout: "allowed", FundedIN: "own_only" };
const POL_TONE: Record<string, "up" | "info" | "warn" | "down" | ""> = { AUTO: "up", CONFIRM: "info", MANUAL: "warn", PAPER: "", BLOCKED: "down" };

type Rules = { daily_loss_pct?: number; max_loss_pct?: number; profit_target_pct?: number; split?: number; copy_rule?: string; multiplier?: number; skip_below_min?: boolean };

function AddAccount({ investors, onDone, onClose }: { investors: Investor[]; onDone: () => void; onClose: () => void }) {
  const [f, setF] = useState({ name: "", type: "sub" as AccountType, venue: "The5ers", investor_id: "", currency: "USD", start: "", risk: "0.5", policy: "PAPER" as CopyPolicy, daily: "", max: "", target: "", split: "", rule: "own_only" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value, ...(k === "venue" ? { rule: COPY_RULE_DEFAULT[e.target.value] ?? "allowed" } : {}) });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const start = toNum(f.start);
    if (!f.name.trim() || !(start > 0)) return setErr("Name and a positive balance are required");
    if (f.type === "investor" && !f.investor_id) return setErr("Investor accounts need an investor");
    const rules: Rules = { copy_rule: f.rule, skip_below_min: true };
    if (f.daily) rules.daily_loss_pct = toNum(f.daily);
    if (f.max) rules.max_loss_pct = toNum(f.max);
    if (f.target) rules.profit_target_pct = toNum(f.target);
    if (f.split) rules.split = toNum(f.split) / 100;
    const { error } = await supabase.from("trading_accounts").insert({ name: f.name.trim(), type: f.type, venue: f.venue, investor_id: f.investor_id || null, currency: f.currency, start_balance: start, balance: start, equity: start, hwm: start, risk_pct: toNum(f.risk), copy_policy: f.policy, firm_rules: rules });
    if (error) return setErr(error.message);
    onDone();
  };
  const sel = (k: keyof typeof f, opts: readonly string[], labels?: Record<string, string>) => <div className="inp"><select value={f[k]} onChange={set(k)}>{opts.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}</select></div>;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="New account">
      <form className="card" onSubmit={submit}>
        <div className="ch"><h3>New account</h3><span className="sp" /><button type="button" className="btn ghost sm" onClick={onClose}>Close</button></div>
        <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
          <label className="fld"><span>Name</span><div className="inp txt"><input value={f.name} onChange={set("name")} /></div></label>
          <label className="fld"><span>Type</span>{sel("type", TYPES)}</label>
          <label className="fld"><span>Venue</span>{sel("venue", VENUES)}</label>
          <label className="fld"><span>Investor</span><div className="inp"><select value={f.investor_id} onChange={set("investor_id")}><option value="">—</option>{investors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div></label>
          <label className="fld"><span>Currency</span>{sel("currency", ["USD", "USDT", "INR"])}</label>
          <label className="fld"><span>Start balance</span><div className="inp"><input inputMode="decimal" value={f.start} onChange={set("start")} /></div></label>
          <label className="fld"><span>Risk per trade</span><div className="inp"><input inputMode="decimal" value={f.risk} onChange={set("risk")} /><span className="u">%</span></div></label>
          <label className="fld"><span>Copy policy</span>{sel("policy", POLICIES)}</label>
          <label className="fld"><span>Daily loss limit</span><div className="inp"><input inputMode="decimal" value={f.daily} onChange={set("daily")} /><span className="u">%</span></div></label>
          <label className="fld"><span>Max loss</span><div className="inp"><input inputMode="decimal" value={f.max} onChange={set("max")} /><span className="u">%</span></div></label>
          <label className="fld"><span>Profit target</span><div className="inp"><input inputMode="decimal" value={f.target} onChange={set("target")} /><span className="u">%</span></div></label>
          <label className="fld"><span>Payout split</span><div className="inp"><input inputMode="decimal" value={f.split} onChange={set("split")} /><span className="u">%</span></div></label>
          <label className="fld" style={{ gridColumn: "1 / -1" }}><span>Firm copy rule</span>{sel("rule", ["allowed", "own_only", "banned"], { allowed: "Copying allowed", own_only: "Own accounts only", banned: "Copying banned — manual only" })}</label>
        </div>
        {err && <p className="down" style={{ fontSize: 12.5, marginTop: 8 }}>{err}</p>}
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}><button className="btn pri">Add account</button></div>
      </form>
    </div>
  );
}

function Detail({ a, investor, onSaved }: { a: TradingAccount; investor?: Investor; onSaved: () => void }) {
  const r = (a.firm_rules ?? {}) as Rules;
  const [mode, setMode] = useState(((a as unknown as { sizing_mode?: string }).sizing_mode ?? "risk_pct") as "risk_pct" | "equity_ratio" | "fixed");
  const [v, setV] = useState({ risk: String(a.risk_pct), mult: String(r.multiplier ?? 1), max: String((a as unknown as { max_size?: number }).max_size ?? ""), daily: String(r.daily_loss_pct ?? ""), bal: String(a.balance), eq: String(a.equity) });
  const [skip, setSkip] = useState(r.skip_below_min !== false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    const patch = {
      risk_pct: toNum(v.risk), sizing_mode: mode, max_size: v.max ? toNum(v.max) : null,
      balance: toNum(v.bal), equity: toNum(v.eq), hwm: Math.max(Number(a.hwm ?? 0), toNum(v.eq)),
      firm_rules: { ...r, multiplier: toNum(v.mult) || 1, daily_loss_pct: v.daily ? toNum(v.daily) : undefined, skip_below_min: skip },
    };
    const { error } = await supabase.from("trading_accounts").update(patch).eq("id", a.id);
    setMsg(error ? error.message : "Saved");
    if (!error) onSaved();
  };
  const fld = (k: keyof typeof v, label: string, unit?: string) => <label className="fld"><span>{label}</span><div className="inp"><input inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />{unit && <span className="u">{unit}</span>}</div></label>;
  return (
    <div className="card s4">
      <div className="ch"><h3>{a.name}</h3><span className="sp" /><Chip tone={POL_TONE[a.copy_policy]}>{a.copy_policy}</Chip></div>
      <span className="faint" style={{ fontSize: 12 }}>{a.venue} · {a.type}{investor ? ` · ${investor.name}` : ""}</span>
      <div className="lbl-u" style={{ margin: "14px 0 6px" }}>Sizing</div>
      <div className="seg" role="group" aria-label="Sizing mode" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        {([["risk_pct", "Risk %"], ["equity_ratio", "Equity ratio"], ["fixed", "Fixed lot"]] as const).map(([k, l]) => <button key={k} type="button" className={mode === k ? "on" : ""} onClick={() => setMode(k)}>{l}</button>)}
      </div>
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 10 }}>
        {fld("risk", "Risk per trade", "%")}{fld("mult", "Multiplier", "×")}{fld("max", "Max size")}{fld("daily", "Daily loss stop", "%")}{fld("bal", "Balance")}{fld("eq", "Equity")}
      </div>
      <div className="lbl-u" style={{ margin: "14px 0 2px" }}>Rules</div>
      {[
        ["Firm copy rule", <span key="r" className="mono faint">{r.copy_rule ? r.copy_rule.replace("_", " ") : "not set"}</span>],
        ["Performance fee (HWM)", <span key="f" className="mono">{investor ? pct(Number(investor.fee_rate), 0) : "—"}</span>],
        ["Copy skip if below min size", <Toggle key="s" on={skip} onChange={setSkip} label="Skip below minimum" />],
        ["Consent & mandate on file", <Chip key="c" tone={investor?.agreement_signed_at ? "up" : investor ? "warn" : ""}>{investor ? (investor.agreement_signed_at ? "signed" : "missing") : "own account"}</Chip>],
      ].map(([k, el]) => (
        <div key={k as string} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}><span>{k}</span>{el}</div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <select className="chip" aria-label="Copy policy" value={a.copy_policy} onChange={async (e) => { await supabase.from("trading_accounts").update({ copy_policy: e.target.value }).eq("id", a.id); onSaved(); }}>{POLICIES.map((p) => <option key={p}>{p}</option>)}</select>
        <span style={{ flex: 1 }} />
        {msg && <span className={msg === "Saved" ? "up" : "down"} style={{ fontSize: 12 }}>{msg}</span>}
        <button className="btn pri sm" onClick={save}>Save</button>
      </div>
    </div>
  );
}

export default function Accounts() {
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const investors = useRows<Investor>({ table: "investors", order: "name", ascending: true });
  const routes = useRows<CopyRoute>({ table: "copy_routes" });
  const orders = useRows<Order>({ table: "orders", order: "created_at", limit: 200 });
  const signals = useRows<Signal>({ table: "signals", select: "id,instrument,side,created_at", order: "created_at", limit: 100 });
  const trades = useRows<Trade>({ table: "trades", select: "id,account_id,pnl,closed_at", order: "closed_at", limit: 2000 });
  const [filter, setFilter] = useState<"all" | AccountType>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const acc = accounts.rows ?? [];
  const inv = (id: string | null) => (investors.rows ?? []).find((i) => i.id === id);
  const name = (id: string) => acc.find((a) => a.id === id)?.name ?? "—";
  const ord = orders.rows ?? [];
  const today = ord.filter((o) => istDay(o.created_at) === todayIst());
  const lat = ord.map((o) => o.latency_ms).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const p = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] : null);
  const slips = ord.filter((o) => o.fill_price !== null).slice(0, 30).map((o) => Math.abs(Number(o.fill_price) - Number(o.entry)) / Math.abs(Number(o.entry) - Number(o.stop)));
  const todayPnl = (id: string) => (trades.rows ?? []).filter((t) => t.account_id === id && t.closed_at && istDay(t.closed_at) === todayIst()).reduce((s, t) => s + Number(t.pnl ?? 0), 0);

  // copy groups = routes grouped by master + instrument
  const groups = new Map<string, CopyRoute[]>();
  for (const r of routes.rows ?? []) { const k = `${r.master_account_id}|${r.instrument}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const rows = acc.filter((a) => filter === "all" || a.type === filter);
  const selected = acc.find((a) => a.id === sel) ?? rows[0] ?? null;
  const toggleGroup = async (rs: CopyRoute[], on: boolean) => { await supabase.from("copy_routes").update({ enabled: on }).in("id", rs.map((r) => r.id)); routes.reload(); };

  return (
    <>
      <ErrorNote error={accounts.error || orders.error} />
      <section className="g12">
        <div className="card s3"><div className="lbl">Copy fills today</div><div className="kv" style={{ marginTop: 6 }}>{today.filter((o) => o.status === "filled").length} / {today.length}</div><div className="faint" style={{ fontSize: 12 }}>{today.filter((o) => o.action === "BLOCK").length} blocked by guard</div></div>
        <div className="card s3"><div className="lbl">Fan-out latency p50 / p95</div><div className="kv" style={{ marginTop: 6 }}>{p(0.5) ?? "—"} / {p(0.95) ?? "—"} ms</div><div className="faint" style={{ fontSize: 12 }}>master fill → copy ack</div></div>
        <div className="card s3"><div className="lbl">Avg copy slippage</div><div className="kv" style={{ marginTop: 6 }}>{slips.length ? `${num(slips.reduce((s, x) => s + x, 0) / slips.length, 2)} R` : "—"}</div><div className="faint" style={{ fontSize: 12 }}>vs master fill, last {slips.length}</div></div>
        <div className="card s3"><div className="lbl">Manual tickets waiting</div><div className={`kv ${ord.some((o) => o.status === "manual_pending") ? "warn" : ""}`} style={{ marginTop: 6 }}>{ord.filter((o) => o.status === "manual_pending" || o.status === "awaiting_confirm").length}</div><div className="faint" style={{ fontSize: 12 }}>manual + confirm policies</div></div>
      </section>

      <section className="card">
        <div className="ch"><h3>Copy groups</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Master order → each target, sized on its own equity</span></div>
        {groups.size === 0 ? <Empty>Add routes in the Copy Engine to form groups</Empty> : (
          <div className="auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))", gap: 12 }}>
            {Array.from(groups.entries()).map(([k, rs]) => {
              const [mid, ins] = k.split("|");
              const on = rs.some((r) => r.enabled);
              const tg = rs.map((r) => acc.find((a) => a.id === r.target_account_id)).filter(Boolean) as TradingAccount[];
              const cnt = (pol: string) => tg.filter((t) => t.copy_policy === pol).length;
              return (
                <div key={k} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 16, background: "var(--surface-2)", border: "1px solid var(--line)" }}>
                  <div className="between"><b>{name(mid!)} · {ins}</b><Toggle on={on} onChange={(v) => toggleGroup(rs, v)} label="Group active" /></div>
                  <div className="row" style={{ fontSize: 12 }}>
                    <span style={{ padding: "5px 9px", borderRadius: 9, background: "var(--surface)", border: "1px solid var(--accent)", color: "var(--accent-ink)", fontWeight: 500 }}>{name(mid!)}</span>
                    <span className="faint">→</span>
                    {tg.map((t) => <span key={t.id} style={{ padding: "5px 9px", borderRadius: 9, background: "var(--surface)", border: "1px solid var(--line)", fontWeight: 500, opacity: rs.find((r) => r.target_account_id === t.id)?.enabled ? 1 : 0.45 }}>{t.name}</span>)}
                  </div>
                  <div className="row">
                    {POLICIES.filter((pol) => cnt(pol)).map((pol) => <Chip key={pol} tone={POL_TONE[pol]}>{cnt(pol)} {pol}</Chip>)}
                    <Chip>{ins}</Chip>{!on && <Chip tone="warn">Paused</Chip>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="g12">
        <div className="card flush s8">
          <div className="ch" style={{ padding: "14px 16px 0" }}>
            <h3>All accounts</h3><span className="sp" />
            <Seg label="Filter" value={filter} onChange={setFilter} options={[{ v: "all", l: "All" }, { v: "master", l: "Master" }, { v: "sub", l: "Sub" }, { v: "eval", l: "Eval" }, { v: "demo", l: "Demo" }, { v: "investor", l: "Investor" }]} />
            <button className="btn pri sm" onClick={() => setAdding(true)}>Add account</button>
          </div>
          {rows.length === 0 ? <div style={{ padding: 16 }}><Empty>No accounts</Empty></div> : (
            <Table head={["Account", "Type", "Equity", "Today", "Sizing", "Share", "Policy", "Trading"]} right={[2, 3]}>
              {rows.map((a) => {
                const t = todayPnl(a.id);
                const i = inv(a.investor_id);
                return (
                  <tr key={a.id} onClick={() => setSel(a.id)} style={{ cursor: "pointer", background: selected?.id === a.id ? "var(--accent-bg)" : undefined }}>
                    <td><div className="col" style={{ gap: 1 }}><b style={{ fontWeight: 500 }}>{a.name}</b><span className="faint" style={{ fontSize: 11 }}>{a.venue}{i ? ` · ${i.name}` : ""}</span></div></td>
                    <td><Chip>{a.type}</Chip></td>
                    <td className="r mono">{money(Number(a.equity), a.currency)}</td>
                    <td className={`r mono ${signed(t)}`}>{t > 0 ? "+" : ""}{money(t, a.currency)}</td>
                    <td className="muted">{num(Number(a.risk_pct), 2)}% risk</td>
                    <td className="mono">{i ? pct(Number(i.fee_rate), 0) : "—"}</td>
                    <td><Chip tone={POL_TONE[a.copy_policy]}>{a.copy_policy}</Chip></td>
                    <td onClick={(e) => e.stopPropagation()}><Toggle on={a.active} onChange={async (v) => { await supabase.from("trading_accounts").update({ active: v }).eq("id", a.id); accounts.reload(); }} label={`Trading enabled for ${a.name}`} /></td>
                  </tr>
                );
              })}
            </Table>
          )}
        </div>
        {selected ? <Detail key={selected.id} a={selected} investor={inv(selected.investor_id)} onSaved={accounts.reload} /> : <div className="card s4"><Empty>Select an account</Empty></div>}
      </section>

      <section className="card flush">
        <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Live copy log</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Reconciler updates fills as they arrive</span></div>
        {ord.length === 0 ? <div style={{ padding: 16 }}><Empty>No copies yet</Empty></div> : (
          <Table head={["Time", "Master order", "Target", "Qty", "Fill", "Slippage", "Latency", "Status"]} right={[3, 4, 5, 6]}>
            {ord.slice(0, 40).map((o) => {
              const s = (signals.rows ?? []).find((x) => x.id === o.signal_id);
              const slip = o.fill_price !== null ? Number(o.fill_price) - Number(o.entry) : null;
              const tone = o.status === "filled" ? "up" : o.status === "blocked" || o.status === "rejected" ? "down" : o.status.includes("pending") || o.status.includes("confirm") ? "warn" : "";
              return (
                <tr key={o.id}>
                  <td className="mono faint">{new Date(o.created_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })}</td>
                  <td>{s ? `${s.instrument} ${s.side}` : `manual ${o.side}`}</td>
                  <td>{name(o.account_id)}</td>
                  <td className="r mono">{num(Number(o.qty), 3)}</td>
                  <td className="r mono">{o.fill_price !== null ? num(Number(o.fill_price), 2) : "—"}</td>
                  <td className="r mono">{slip !== null ? `${slip > 0 ? "+" : ""}${num(slip, 2)}` : "—"}</td>
                  <td className="r mono">{o.latency_ms !== null ? `${o.latency_ms} ms` : o.action === "MANUAL" ? "manual" : "—"}</td>
                  <td><Chip tone={tone as "up" | "down" | "warn" | ""}>{o.action === "PAPER" ? "paper · " : ""}{o.status.replace(/_/g, " ")}</Chip></td>
                </tr>
              );
            })}
          </Table>
        )}
      </section>
      {adding && <AddAccount investors={investors.rows ?? []} onClose={() => setAdding(false)} onDone={() => { setAdding(false); accounts.reload(); }} />}
      {acc.length > 0 && acc.every((a) => a.copy_policy === "PAPER") && <Note tone="info">All accounts are on PAPER — set a policy per account when you&apos;re ready.</Note>}
    </>
  );
}
