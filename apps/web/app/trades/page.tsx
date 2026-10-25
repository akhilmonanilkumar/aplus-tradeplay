"use client";

import { useMemo, useState } from "react";
import { rewardToRisk } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { realizedR } from "@/lib/calc";
import type { Trade, TradingAccount } from "@/lib/types";
import { dateShort, money, num, r, signed, toNum } from "@/lib/fmt";
import { Badge, Card, Empty, ErrorNote, Field, PageHead, Segmented, Table } from "@/components/ui";

const BREAKS = ["chased", "no sweep", "counter-trend", "off-window", "moved stop", "stretched TP", "over-size", "revenge"];

const blank = { account_id: "", instrument: "XAUUSD", side: "long" as "long" | "short", model: "A", session: "ny_q", qty: "", entry: "", stop: "", target: "", exit: "", pnl: "", fees: "", mood: "7", review: "" };

export default function Journal() {
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 1000 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,currency,type", order: "created_at", ascending: true });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(blank);
  const [breaks, setBreaks] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "XAUUSD" | "BTCUSDT.P">("all");
  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const preview = useMemo(() => {
    const e = toNum(f.entry), s = toNum(f.stop), t = toNum(f.target), x = toNum(f.exit);
    let planned: number | null = null, realized: number | null = null;
    try { if (e > 0 && s > 0 && t > 0) planned = rewardToRisk(e, s, t); } catch { planned = null; }
    if (e > 0 && s > 0 && x > 0) realized = realizedR(f.side, e, s, x);
    return { planned, realized };
  }, [f]);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const entry = toNum(f.entry), stop = toNum(f.stop), qty = toNum(f.qty);
    if (!f.account_id || !(entry > 0) || !(stop > 0) || !(qty > 0)) return setError("Account, qty, entry and stop are required");
    const exit = f.exit ? toNum(f.exit) : null;
    const { error } = await supabase.from("trades").insert({
      account_id: f.account_id, instrument: f.instrument, side: f.side, model: f.model, session_window: f.session,
      qty, entry, stop, target: f.target ? toNum(f.target) : null, exit,
      planned_r: preview.planned !== null ? Number(preview.planned.toFixed(3)) : null,
      realized_r: preview.realized !== null ? Number(preview.realized.toFixed(3)) : null,
      pnl: f.pnl ? toNum(f.pnl) : null, fees: f.fees ? toNum(f.fees) : null,
      rule_breaks: breaks, mood: Number(f.mood) || null, review: f.review.trim() || null,
      closed_at: exit ? new Date().toISOString() : null, edge_version: "1.0",
    });
    if (error) return setError(error.message);
    setError(null);
    setF({ ...blank, account_id: f.account_id });
    setBreaks([]);
    setOpen(false);
    trades.reload();
  };

  const acc = (id: string) => (accounts.rows ?? []).find((a) => a.id === id);
  const rows = (trades.rows ?? []).filter((t) => filter === "all" || t.instrument === filter);

  return (
    <div>
      <PageHead title="Journal" right={<>
        <Segmented value={filter} onChange={setFilter} options={[{ v: "all", l: "All" }, { v: "XAUUSD", l: "Gold" }, { v: "BTCUSDT.P", l: "BTC" }]} />
        <button className="btn-accent" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Log trade"}</button>
      </>} />
      <ErrorNote error={error || trades.error} />

      {open && (
        <Card title="New trade" className="mb-4" right={<span className="num text-sm">{r(preview.planned)} planned · <span className={signed(preview.realized ?? 0)}>{r(preview.realized)}</span></span>}>
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Field label="Account" className="lg:col-span-2">
              <select className="input" value={f.account_id} onChange={set("account_id")}>
                <option value="">—</option>
                {(accounts.rows ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Instrument"><select className="input" value={f.instrument} onChange={set("instrument")}><option>XAUUSD</option><option>BTCUSDT.P</option><option>GOLDM</option><option>GOLD</option></select></Field>
            <Field label="Side"><Segmented value={f.side} onChange={(v) => setF({ ...f, side: v })} options={[{ v: "long", l: "Long" }, { v: "short", l: "Short" }]} /></Field>
            <Field label="Model"><select className="input" value={f.model} onChange={set("model")}><option>A</option><option>B</option><option>C</option><option>CT1</option></select></Field>
            <Field label="Session"><select className="input" value={f.session} onChange={set("session")}><option value="london_q">London Q</option><option value="ny_q">NY Q</option><option value="other">Other</option></select></Field>
            <Field label="Qty"><input className="input num" inputMode="decimal" value={f.qty} onChange={set("qty")} /></Field>
            <Field label="Entry"><input className="input num" inputMode="decimal" value={f.entry} onChange={set("entry")} /></Field>
            <Field label="Stop"><input className="input num" inputMode="decimal" value={f.stop} onChange={set("stop")} /></Field>
            <Field label="Target"><input className="input num" inputMode="decimal" value={f.target} onChange={set("target")} /></Field>
            <Field label="Exit"><input className="input num" inputMode="decimal" value={f.exit} onChange={set("exit")} /></Field>
            <Field label="P&L"><input className="input num" inputMode="decimal" value={f.pnl} onChange={set("pnl")} /></Field>
            <Field label="Fees"><input className="input num" inputMode="decimal" value={f.fees} onChange={set("fees")} /></Field>
            <Field label={`Mood · ${f.mood}`} className="lg:col-span-2"><input type="range" min={1} max={10} className="w-full accent-[rgb(var(--accent))]" value={f.mood} onChange={set("mood")} /></Field>
            <div className="sm:col-span-2 lg:col-span-6">
              <span className="label mb-1.5 block">Rule breaks</span>
              <div className="flex flex-wrap gap-1.5">
                {BREAKS.map((b) => (
                  <button key={b} type="button" onClick={() => setBreaks((x) => (x.includes(b) ? x.filter((y) => y !== b) : [...x, b]))} className={`chip ${breaks.includes(b) ? "border-down bg-down/15 text-down" : "text-mute"}`}>{b}</button>
                ))}
              </div>
            </div>
            <Field label="Review" className="sm:col-span-2 lg:col-span-6"><textarea className="input min-h-[72px]" value={f.review} onChange={set("review")} /></Field>
            <div className="lg:col-span-6"><button className="btn-accent">Save trade</button></div>
          </form>
        </Card>
      )}

      <Card>
        {rows.length === 0 ? <Empty>No trades</Empty> : (
          <Table head={["Date", "Account", "Instrument", "Side", "Entry / Stop", "Exit", "Planned", "Result", "P&L"]}>
            {rows.map((t) => {
              const a = acc(t.account_id);
              return (
                <tr key={t.id}>
                  <td className="num text-mute">{dateShort(t.opened_at)}</td>
                  <td className="max-w-[160px] truncate">{a?.name ?? "—"}</td>
                  <td>{t.instrument} <span className="text-xs text-mute">{t.model}</span></td>
                  <td><Badge tone={t.side === "long" ? "up" : "down"}>{t.side}</Badge></td>
                  <td className="num">{num(Number(t.entry), 2)} / {num(Number(t.stop), 2)}</td>
                  <td className="num">{t.exit !== null ? num(Number(t.exit), 2) : <Badge tone="accent">open</Badge>}</td>
                  <td className="num">{r(t.planned_r)}</td>
                  <td className={`num ${signed(Number(t.realized_r ?? 0))}`}>{r(t.realized_r)}{t.rule_breaks.length > 0 && <span className="ml-1 text-down">•</span>}</td>
                  <td className={`num ${signed(Number(t.pnl ?? 0))}`}>{t.pnl !== null ? money(Number(t.pnl), a?.currency ?? "USD") : "—"}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
