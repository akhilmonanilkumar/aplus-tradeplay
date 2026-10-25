"use client";

import { useMemo, useState } from "react";
import { hwmFee, propPayout } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { Investor, Payout, TradingAccount } from "@/lib/types";
import { money, pct, toNum } from "@/lib/fmt";
import { Badge, Card, Empty, ErrorNote, Field, Kpi, PageHead, Row, Segmented, Table } from "@/components/ui";

const TONE: Record<Payout["status"], string> = { pending: "warn", approved: "accent", paid: "up", held: "down" };

export default function Payouts() {
  const payouts = useRows<Payout>({ table: "payouts", order: "created_at" });
  const investors = useRows<Investor>({ table: "investors", order: "name", ascending: true });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,investor_id,equity,hwm,start_balance,firm_rules,currency" });
  const [kind, setKind] = useState<"prop" | "hwm">("prop");
  const [f, setF] = useState({ investor_id: "", account_id: "", period: new Date().toISOString().slice(0, 7), profit: "", split: "80", nav: "", hwm: "" });
  const [error, setError] = useState<string | null>(null);

  const investor = (investors.rows ?? []).find((i) => i.id === f.investor_id);
  const invAccounts = (accounts.rows ?? []).filter((a) => a.investor_id === f.investor_id);
  const rate = investor ? Number(investor.fee_rate) : 0.2;

  const calc = useMemo(() => {
    try {
      if (kind === "prop") {
        const profit = toNum(f.profit), split = toNum(f.split) / 100;
        if (!(profit >= 0) || !(split > 0 && split <= 1)) return null;
        const p = propPayout({ profit, firmSplit: split, ourRate: rate });
        return { gross: profit, firm_split: split, hwm_before: null, commission: p.commission, to_investor: p.toInvestor, firmPays: p.firmPays, firmKeeps: p.firmKeeps };
      }
      const nav = toNum(f.nav), hwm = toNum(f.hwm);
      if (!(nav > 0) || !(hwm > 0)) return null;
      const h = hwmFee({ navEnd: nav, hwm, rate });
      return { gross: h.above, firm_split: null, hwm_before: hwm, commission: h.fee, to_investor: h.toInvestor, newHwm: h.newHwm };
    } catch { return null; }
  }, [kind, f, rate]);

  const pickAccount = (id: string) => {
    const a = invAccounts.find((x) => x.id === id);
    setF({ ...f, account_id: id, split: a?.firm_rules?.split ? String(a.firm_rules.split * 100) : f.split, nav: a ? String(a.equity) : f.nav, hwm: a?.hwm ? String(a.hwm) : a ? String(a.start_balance) : f.hwm });
  };

  const save = async () => {
    if (!calc || !investor) return;
    if (calc.gross <= 0) return setError("Nothing above the high-water mark");
    const { error } = await supabase.from("payouts").insert({
      investor_id: investor.id, account_id: f.account_id || null, kind, period: f.period,
      gross: calc.gross, firm_split: calc.firm_split, hwm_before: calc.hwm_before, commission: calc.commission, to_investor: calc.to_investor,
    });
    if (error) return setError(error.message);
    setError(null);
    setF({ ...f, profit: "" });
    payouts.reload();
  };

  const setStatus = async (id: string, status: Payout["status"]) => {
    const { error } = await supabase.from("payouts").update({ status }).eq("id", id);
    if (error) setError(error.message); else payouts.reload();
  };

  const rows = payouts.rows ?? [];
  const paid = rows.filter((p) => p.status === "paid");
  const name = (id: string) => (investors.rows ?? []).find((i) => i.id === id)?.name ?? "—";

  return (
    <div>
      <PageHead title="Payouts" />
      <ErrorNote error={error || payouts.error} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Kpi label="Commission paid" value={money(paid.reduce((s, p) => s + Number(p.commission), 0))} tone="text-accent" />
        <Kpi label="To investors" value={money(paid.reduce((s, p) => s + Number(p.to_investor), 0))} />
        <Kpi label="Pending" value={rows.filter((p) => p.status === "pending").length} foot={money(rows.filter((p) => p.status === "pending").reduce((s, p) => s + Number(p.commission), 0)) + " commission"} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Card title="Split" right={<Segmented value={kind} onChange={setKind} options={[{ v: "prop", l: "Prop payout" }, { v: "hwm", l: "Managed · HWM" }]} />}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Investor">
              <select className="input" value={f.investor_id} onChange={(e) => setF({ ...f, investor_id: e.target.value, account_id: "" })}>
                <option value="">—</option>
                {(investors.rows ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </Field>
            <Field label="Account">
              <select className="input" value={f.account_id} onChange={(e) => pickAccount(e.target.value)}>
                <option value="">—</option>
                {invAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Period"><input className="input num" type="month" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></Field>
            {kind === "prop" ? (
              <>
                <Field label="Profit $"><input className="input num" inputMode="decimal" value={f.profit} onChange={(e) => setF({ ...f, profit: e.target.value })} /></Field>
                <Field label="Firm split %"><input className="input num" inputMode="decimal" value={f.split} onChange={(e) => setF({ ...f, split: e.target.value })} /></Field>
              </>
            ) : (
              <>
                <Field label="NAV end $"><input className="input num" inputMode="decimal" value={f.nav} onChange={(e) => setF({ ...f, nav: e.target.value })} /></Field>
                <Field label="High-water mark $"><input className="input num" inputMode="decimal" value={f.hwm} onChange={(e) => setF({ ...f, hwm: e.target.value })} /></Field>
              </>
            )}
            <Field label="Our fee"><div className="input num flex items-center">{pct(rate, 0)}</div></Field>
          </div>
        </Card>
        <Card title="Breakdown">
          {!calc ? <p className="text-sm text-mute">Enter the figures.</p> : (
            <>
              <div className="divide-y divide-line">
                {"firmPays" in calc && calc.firmPays !== undefined && (
                  <>
                    <Row k="Profit" v={money(calc.gross)} />
                    <Row k="Firm keeps" v={money(calc.firmKeeps!)} tone="text-mute" />
                    <Row k="Firm pays out" v={money(calc.firmPays)} />
                  </>
                )}
                {kind === "hwm" && <Row k="Above HWM" v={money(calc.gross)} />}
                <Row k={`A+ commission · ${pct(rate, 0)}`} v={money(calc.commission)} tone="text-accent" />
                <Row k="To investor" v={money(calc.to_investor)} tone="text-up" />
                {"newHwm" in calc && calc.newHwm !== undefined && <Row k="New HWM" v={money(calc.newHwm)} />}
              </div>
              <button className="btn-accent mt-4 w-full" onClick={save} disabled={!investor}>Record payout</button>
            </>
          )}
        </Card>
      </div>

      <Card title="Ledger" className="mt-4">
        {rows.length === 0 ? <Empty>No payouts</Empty> : (
          <Table head={["Investor", "Period", "Kind", "Gross", "Commission", "To investor", "Status", ""]}>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{name(p.investor_id)}</td>
                <td className="num text-mute">{p.period}</td>
                <td className="text-mute">{p.kind === "prop" ? "Prop" : "HWM"}</td>
                <td className="num">{money(Number(p.gross))}</td>
                <td className="num text-accent">{money(Number(p.commission))}</td>
                <td className="num">{money(Number(p.to_investor))}</td>
                <td><Badge tone={TONE[p.status]}>{p.status}</Badge></td>
                <td className="whitespace-nowrap">
                  {p.status === "pending" && <><button className="btn-ghost min-h-0 py-1 text-xs" onClick={() => setStatus(p.id, "approved")}>Approve</button> <button className="btn min-h-0 py-1 text-xs text-mute" onClick={() => setStatus(p.id, "held")}>Hold</button></>}
                  {p.status === "approved" && <button className="btn-ghost min-h-0 py-1 text-xs" onClick={() => setStatus(p.id, "paid")}>Mark paid</button>}
                  {p.status === "held" && <button className="btn-ghost min-h-0 py-1 text-xs" onClick={() => setStatus(p.id, "pending")}>Release</button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
