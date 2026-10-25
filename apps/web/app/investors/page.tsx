"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { Investor, PropPurchase, Stage, TradingAccount } from "@/lib/types";
import { dateShort, money, pct, toNum } from "@/lib/fmt";
import { Badge, Card, Empty, ErrorNote, Field, Kpi, PageHead, Table } from "@/components/ui";

const STAGES: Stage[] = ["kyc", "payment", "to_purchase", "evaluation", "funded", "payout_pending", "breached", "closed"];
const FIRMS = ["The5ers", "FundedHive", "FundedIN", "Breakout", "Other"];
const label = (s: string) => s.replace(/_/g, " ");

export default function Investors() {
  const investors = useRows<Investor>({ table: "investors", order: "created_at" });
  const purchases = useRows<PropPurchase>({ table: "prop_purchases", order: "created_at" });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,investor_id,equity,start_balance,currency" });
  const [error, setError] = useState<string | null>(null);
  const [inv, setInv] = useState({ name: "", email: "", model: "prop_profit_share", fee: "20" });
  const [pp, setPp] = useState({ investor_id: "", firm: "The5ers", plan: "", size: "", fee: "", paid_by: "investor" });
  const [open, setOpen] = useState<"inv" | "pp" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const list = investors.rows ?? [];
  const name = (id: string) => list.find((i) => i.id === id)?.name ?? "—";

  const addInvestor = async (e: React.FormEvent) => {
    e.preventDefault();
    const fee = toNum(inv.fee) / 100;
    if (!inv.name.trim() || !(fee >= 0 && fee <= 1)) return setError("Name and a fee between 0 and 100% are required");
    const { error } = await supabase.from("investors").insert({ name: inv.name.trim(), email: inv.email.trim() || null, model: inv.model, fee_rate: fee });
    if (error) return setError(error.message);
    setInv({ name: "", email: "", model: "prop_profit_share", fee: "20" });
    setOpen(null);
    investors.reload();
  };

  const addPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    const size = toNum(pp.size);
    if (!pp.investor_id || !pp.plan.trim() || !(size > 0)) return setError("Investor, plan and size are required");
    const ref = `PP-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const { error } = await supabase.from("prop_purchases").insert({
      ref, investor_id: pp.investor_id, firm: pp.firm, plan: pp.plan.trim(), size, fee: toNum(pp.fee) || null, paid_by: pp.paid_by,
    });
    if (error) return setError(error.message);
    setPp({ ...pp, plan: "", size: "", fee: "" });
    setOpen(null);
    purchases.reload();
  };

  const setStage = async (id: string, stage: Stage) => {
    const { error } = await supabase.from("investors").update({ stage }).eq("id", id);
    if (error) setError(error.message); else investors.reload();
  };
  const setPurchase = async (id: string, status: PropPurchase["status"]) => {
    const patch: Record<string, unknown> = { status };
    if (status === "evaluation") patch.purchased_at = new Date().toISOString();
    const { error } = await supabase.from("prop_purchases").update(patch).eq("id", id);
    if (error) setError(error.message); else purchases.reload();
  };
  const invite = async (id: string) => {
    setNote(null);
    const { data } = await supabase.auth.getSession();
    const res = await fetch("/api/invite", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: JSON.stringify({ investorId: id }) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) setError(j.error ?? "Invite failed"); else setNote("Invite sent");
  };

  const funded = list.filter((i) => i.stage === "funded").length;
  const pipeline = STAGES.map((s) => ({ s, n: list.filter((i) => i.stage === s).length }));

  return (
    <div>
      <PageHead title="Investors" right={<>
        <button className="btn-ghost" onClick={() => setOpen(open === "pp" ? null : "pp")}>Prop purchase</button>
        <button className="btn-accent" onClick={() => setOpen(open === "inv" ? null : "inv")}>Add investor</button>
      </>} />
      <ErrorNote error={error || investors.error} />
      {note && <div className="mb-4 rounded-xl bg-up/10 px-3 py-2 text-sm text-up">{note}</div>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Kpi label="Investors" value={list.length} foot={`${list.filter((i) => i.user_id).length} with login`} />
        <Kpi label="Funded" value={funded} />
        <Kpi label="Prop purchases" value={purchases.rows?.length ?? 0} foot={`${(purchases.rows ?? []).filter((p) => p.status === "to_purchase").length} to buy`} />
      </div>

      {open === "inv" && (
        <Card title="New investor" className="mt-4">
          <form onSubmit={addInvestor} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Name"><input className="input" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} /></Field>
            <Field label="Email"><input className="input" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></Field>
            <Field label="Model">
              <select className="input" value={inv.model} onChange={(e) => setInv({ ...inv, model: e.target.value })}>
                <option value="prop_profit_share">Prop · payout share</option>
                <option value="managed_capital">Managed · HWM</option>
                <option value="both">Both</option>
              </select>
            </Field>
            <Field label="Fee %"><input className="input num" inputMode="decimal" value={inv.fee} onChange={(e) => setInv({ ...inv, fee: e.target.value })} /></Field>
            <div className="flex items-end"><button className="btn-accent w-full">Save</button></div>
          </form>
        </Card>
      )}
      {open === "pp" && (
        <Card title="New prop purchase" className="mt-4">
          <form onSubmit={addPurchase} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Field label="Investor">
              <select className="input" value={pp.investor_id} onChange={(e) => setPp({ ...pp, investor_id: e.target.value })}>
                <option value="">—</option>
                {list.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </Field>
            <Field label="Firm"><select className="input" value={pp.firm} onChange={(e) => setPp({ ...pp, firm: e.target.value })}>{FIRMS.map((f) => <option key={f}>{f}</option>)}</select></Field>
            <Field label="Plan"><input className="input" placeholder="2-step" value={pp.plan} onChange={(e) => setPp({ ...pp, plan: e.target.value })} /></Field>
            <Field label="Size $"><input className="input num" inputMode="decimal" value={pp.size} onChange={(e) => setPp({ ...pp, size: e.target.value })} /></Field>
            <Field label="Fee $"><input className="input num" inputMode="decimal" value={pp.fee} onChange={(e) => setPp({ ...pp, fee: e.target.value })} /></Field>
            <Field label="Paid by"><select className="input" value={pp.paid_by} onChange={(e) => setPp({ ...pp, paid_by: e.target.value })}><option value="investor">Investor</option><option value="aplus">A+</option></select></Field>
            <div className="lg:col-span-6"><button className="btn-accent">Save purchase</button></div>
          </form>
        </Card>
      )}

      <Card title="Pipeline" className="mt-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          {pipeline.map((p) => (
            <div key={p.s} className="rounded-2xl bg-raised p-3">
              <div className="num text-2xl font-semibold">{p.n}</div>
              <div className="label mt-1 truncate">{label(p.s)}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Investors" className="mt-4">
        {list.length === 0 ? <Empty>No investors yet</Empty> : (
          <Table head={["Investor", "Model", "Fee", "Accounts", "Equity", "Stage", ""]}>
            {list.map((i) => {
              const accs = (accounts.rows ?? []).filter((a) => a.investor_id === i.id);
              const eq = accs.reduce((s, a) => s + Number(a.equity), 0);
              return (
                <tr key={i.id}>
                  <td><div className="font-medium">{i.name}</div><div className="text-xs text-mute">{i.email ?? "—"}</div></td>
                  <td className="text-mute">{i.model === "prop_profit_share" ? "Prop" : i.model === "managed_capital" ? "Managed" : "Both"}</td>
                  <td className="num">{pct(Number(i.fee_rate), 0)}</td>
                  <td className="num">{accs.length}</td>
                  <td className="num">{money(eq)}</td>
                  <td>
                    <select className="input min-h-0 w-auto py-1 text-xs" value={i.stage} onChange={(e) => setStage(i.id, e.target.value as Stage)}>
                      {STAGES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                    </select>
                  </td>
                  <td>{i.user_id ? <Badge tone="up">login</Badge> : i.email ? <button className="btn-ghost min-h-0 py-1 text-xs" onClick={() => invite(i.id)}>Invite</button> : null}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="Prop purchases" className="mt-4">
        {(purchases.rows ?? []).length === 0 ? <Empty>None</Empty> : (
          <Table head={["Ref", "Investor", "Firm", "Size", "Fee", "Date", "Status"]}>
            {(purchases.rows ?? []).map((p) => (
              <tr key={p.id}>
                <td className="num text-xs">{p.ref}</td>
                <td>{name(p.investor_id)}</td>
                <td>{p.firm} <span className="text-mute">· {p.plan}</span></td>
                <td className="num">{money(Number(p.size), "USD", 0)}</td>
                <td className="num">{money(p.fee)} <span className="text-xs text-mute">{p.paid_by === "aplus" ? "A+" : "inv"}</span></td>
                <td className="num text-mute">{dateShort(p.created_at)}</td>
                <td>
                  <select className="input min-h-0 w-auto py-1 text-xs" value={p.status} onChange={(e) => setPurchase(p.id, e.target.value as PropPurchase["status"])}>
                    {["to_purchase", "evaluation", "funded", "breached", "refunded", "closed"].map((s) => <option key={s} value={s}>{label(s)}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
