"use client";

import Link from "next/link";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { Investor, Payout, PropPurchase, Stage, TradingAccount } from "@/lib/types";
import { dateShort, money, pct, signed, toNum } from "@/lib/fmt";
import { Chip, Empty, ErrorNote, Note, Seg, Table } from "@/components/ui";

const LIFE: { s: Stage; l: string }[] = [
  { s: "kyc", l: "Agreement & KYC" }, { s: "payment", l: "Payment received" }, { s: "to_purchase", l: "To purchase" },
  { s: "evaluation", l: "In evaluation" }, { s: "funded", l: "Funded" }, { s: "payout_pending", l: "Payout pending" },
];
const STAGES: Stage[] = ["kyc", "payment", "to_purchase", "evaluation", "funded", "payout_pending", "breached", "closed"];
const STAGE_TONE: Partial<Record<Stage, "up" | "down" | "info" | "warn" | "acc">> = { funded: "up", evaluation: "info", payout_pending: "acc", breached: "down", payment: "warn", to_purchase: "warn" };
const P_TONE: Record<string, "up" | "down" | "info" | "warn" | ""> = { to_purchase: "warn", evaluation: "info", funded: "up", breached: "down", refunded: "", closed: "" };
const label = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const ini = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
const MODEL: Record<string, string> = { prop_profit_share: "Prop · 20% of payout", managed_capital: "Managed · 20% over HWM", both: "Prop + managed" };

export default function Investors() {
  const investors = useRows<Investor>({ table: "investors", order: "created_at" });
  const purchases = useRows<PropPurchase>({ table: "prop_purchases", order: "created_at" });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,investor_id,equity,start_balance,currency,type,venue" });
  const payouts = useRows<Payout>({ table: "payouts", order: "created_at" });
  const [filter, setFilter] = useState<"all" | "active" | "onboarding" | "breached">("all");
  const [sel, setSel] = useState<string | null>(null);
  const [modal, setModal] = useState<"inv" | "pp" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [inv, setInv] = useState({ name: "", email: "", model: "prop_profit_share", fee: "20" });
  const [pp, setPp] = useState({ investor_id: "", firm: "FundedHive", plan: "2-step", size: "", fee: "", paid_by: "investor" });

  const list = investors.rows ?? [];
  const accs = accounts.rows ?? [];
  const pays = payouts.rows ?? [];
  const accOf = (id: string) => accs.filter((a) => a.investor_id === id);
  const pnlOf = (id: string) => accOf(id).reduce((s, a) => s + Number(a.equity) - Number(a.start_balance), 0);
  const feesOf = (id: string) => pays.filter((p) => p.investor_id === id && p.status === "paid").reduce((s, p) => s + Number(p.commission), 0);
  const isActive = (i: Investor) => ["evaluation", "funded", "payout_pending"].includes(i.stage);
  const isOnb = (i: Investor) => ["kyc", "payment", "to_purchase"].includes(i.stage);
  const rows = list.filter((i) => filter === "all" || (filter === "active" ? isActive(i) : filter === "onboarding" ? isOnb(i) : i.stage === "breached"));
  const d = list.find((i) => i.id === sel) ?? rows[0] ?? null;
  const invEq = accs.filter((a) => a.investor_id).reduce((s, a) => s + Number(a.equity), 0);
  const ourFees = pays.filter((p) => p.status === "paid").reduce((s, p) => s + Number(p.commission), 0);
  const owed = pays.filter((p) => p.status === "pending" || p.status === "approved").reduce((s, p) => s + Number(p.to_investor), 0);
  const name = (id: string) => list.find((i) => i.id === id)?.name ?? "—";

  const addInvestor = async (e: React.FormEvent) => {
    e.preventDefault();
    const fee = toNum(inv.fee) / 100;
    if (!inv.name.trim() || !(fee >= 0 && fee <= 1)) return setMsg({ ok: false, t: "Name and a fee between 0 and 100%" });
    const { error } = await supabase.from("investors").insert({ name: inv.name.trim(), email: inv.email.trim() || null, model: inv.model, fee_rate: fee });
    if (error) return setMsg({ ok: false, t: error.message });
    setModal(null); setInv({ name: "", email: "", model: "prop_profit_share", fee: "20" }); investors.reload();
  };
  const addPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    const size = toNum(pp.size);
    if (!pp.investor_id || !(size > 0)) return setMsg({ ok: false, t: "Investor and size are required" });
    const n = (purchases.rows ?? []).length + 1;
    const { error } = await supabase.from("prop_purchases").insert({ ref: `PA-${String(n).padStart(4, "0")}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`, investor_id: pp.investor_id, firm: pp.firm, plan: pp.plan, size, fee: toNum(pp.fee) || null, paid_by: pp.paid_by, payment_received_at: pp.paid_by === "investor" ? new Date().toISOString() : null });
    if (error) return setMsg({ ok: false, t: error.message });
    await supabase.from("investors").update({ stage: "to_purchase" }).eq("id", pp.investor_id).in("stage", ["kyc", "payment"]);
    setModal(null); purchases.reload(); investors.reload();
  };
  const setStage = async (id: string, stage: Stage) => { const { error } = await supabase.from("investors").update({ stage }).eq("id", id); if (error) setMsg({ ok: false, t: error.message }); else investors.reload(); };
  const setPurchase = async (id: string, status: string) => { await supabase.from("prop_purchases").update({ status, ...(status === "evaluation" ? { purchased_at: new Date().toISOString() } : {}) }).eq("id", id); purchases.reload(); };
  const markSigned = async (id: string, k: "agreement_signed_at" | "risk_disclosure_at") => { await supabase.from("investors").update({ [k]: new Date().toISOString() }).eq("id", id); investors.reload(); };
  const invite = async (id: string) => {
    const { data } = await supabase.auth.getSession();
    const res = await fetch("/api/invite", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: JSON.stringify({ investorId: id }) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setMsg(res.ok ? { ok: true, t: "Invite sent" } : { ok: false, t: j.error ?? "Invite failed" });
  };

  return (
    <>
      <ErrorNote error={investors.error || purchases.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(170px, 100%), 1fr))" }}>
        <div className="card"><div className="lbl">Investors</div><div className="kv sm" style={{ marginTop: 4 }}>{list.length}</div><div className="faint" style={{ fontSize: 11 }}>{list.filter(isActive).length} active · {list.filter(isOnb).length} onboarding · {list.filter((i) => i.stage === "breached").length} breached</div></div>
        <div className="card"><div className="lbl">Investor accounts</div><div className="kv sm" style={{ marginTop: 4 }}>{accs.filter((a) => a.investor_id).length}</div><div className="faint" style={{ fontSize: 11 }}>{(purchases.rows ?? []).filter((p) => p.status === "funded").length} funded · {(purchases.rows ?? []).filter((p) => p.status === "evaluation").length} in evaluation</div></div>
        <div className="card"><div className="lbl">Investor account equity</div><div className="kv sm" style={{ marginTop: 4 }}>{money(invEq)}</div><div className="faint" style={{ fontSize: 11 }}>prop balances + managed capital</div></div>
        <div className="card"><div className="lbl">Our fees · lifetime</div><div className="kv sm up" style={{ marginTop: 4 }}>{money(ourFees)}</div><div className="faint" style={{ fontSize: 11 }}>20% of payouts / profit over HWM</div></div>
        <div className="card"><div className="lbl">Owed to investors</div><div className="kv sm warn" style={{ marginTop: 4 }}>{money(owed)}</div><div className="faint" style={{ fontSize: 11 }}>pending + approved payouts</div></div>
      </section>

      <section className="card">
        <div className="ch"><h3>Lifecycle</h3><span className="sp" /><button className="btn sm" onClick={() => setModal("pp")}>Record purchase</button><button className="btn pri sm" onClick={() => setModal("inv")}>Add investor</button></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(130px, 1fr))", gap: 8, overflowX: "auto" }}>
          {LIFE.map((x) => {
            const who = list.filter((i) => i.stage === x.s);
            const hot = (x.s === "payment" || x.s === "to_purchase" || x.s === "payout_pending") && who.length > 0;
            return (
              <div key={x.s} style={{ padding: 12, borderRadius: 14, background: "var(--surface-2)", border: `1px solid ${hot ? "var(--accent)" : "var(--line)"}`, display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="lbl">{x.l}</span><b className="kv sm">{who.length}</b>
                <span className="faint" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{who.map((i) => i.name).join(" · ") || "—"}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="g12">
        <div className="card flush s8">
          <div className="ch" style={{ padding: "14px 16px 0" }}><h3>All investors</h3><span className="sp" /><Seg label="Filter" value={filter} onChange={setFilter} options={[{ v: "all", l: "All" }, { v: "active", l: "Active" }, { v: "onboarding", l: "Onboarding" }, { v: "breached", l: "Breached" }]} /></div>
          {rows.length === 0 ? <div style={{ padding: 16 }}><Empty>No investors</Empty></div> : (
            <Table head={["Investor", "Model", "Accounts", "Stage", "Account P&L", "Our fees", "Agreement"]} right={[4, 5]}>
              {rows.map((i) => {
                const p = pnlOf(i.id);
                return (
                  <tr key={i.id} onClick={() => setSel(i.id)} style={{ cursor: "pointer", background: d?.id === i.id ? "var(--accent-bg)" : undefined }}>
                    <td><div className="row" style={{ flexWrap: "nowrap" }}><span className="ava" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>{ini(i.name)}</span><b style={{ fontWeight: 500 }}>{i.name}</b></div></td>
                    <td className="muted">{MODEL[i.model]}</td>
                    <td className="muted">{accOf(i.id).map((a) => a.venue).join(", ") || "—"}</td>
                    <td><Chip tone={STAGE_TONE[i.stage] ?? ""}>{label(i.stage)}</Chip></td>
                    <td className={`r mono ${signed(p)}`}>{p > 0 ? "+" : ""}{money(p)}</td>
                    <td className="r mono">{money(feesOf(i.id))}</td>
                    <td className="muted">{i.agreement_signed_at ? `Signed ${dateShort(i.agreement_signed_at)}` : "Pending"}</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </div>
        <div className="card s4">
          {!d ? <Empty>Select an investor</Empty> : (
            <>
              <div className="ch"><h3>{d.name}</h3><span className="sp" /><Chip tone={STAGE_TONE[d.stage] ?? ""}>{label(d.stage)}</Chip></div>
              {[
                ["Email", d.email ?? "—"],
                ["Model", MODEL[d.model]],
                ["Fee", pct(Number(d.fee_rate), 0)],
                ["KYC", d.kyc_status],
                ["Agreement", d.agreement_signed_at ? dateShort(d.agreement_signed_at) : "missing"],
                ["Risk disclosure", d.risk_disclosure_at ? dateShort(d.risk_disclosure_at) : "missing"],
                ["Equity", money(accOf(d.id).reduce((s, a) => s + Number(a.equity), 0))],
                ["Paid to investor", money(pays.filter((p) => p.investor_id === d.id && p.status === "paid").reduce((s, p) => s + Number(p.to_investor), 0))],
                ["Login", d.user_id ? "linked" : "not invited"],
              ].map(([k, v]) => <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "7px 0", borderBottom: "1px dashed var(--line)" }}><span className="muted">{k}</span><span className="mono">{v}</span></div>)}
              <div className="row" style={{ marginTop: 12 }}>
                <div className="inp" style={{ width: 160, height: 30 }}><select aria-label="Stage" value={d.stage} onChange={(e) => setStage(d.id, e.target.value as Stage)}>{STAGES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></div>
                {!d.agreement_signed_at && <button className="btn sm" onClick={() => markSigned(d.id, "agreement_signed_at")}>Agreement signed</button>}
                {!d.risk_disclosure_at && <button className="btn sm" onClick={() => markSigned(d.id, "risk_disclosure_at")}>Disclosure signed</button>}
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <Link className="btn sm" href={`/me?as=${d.id}`}>Open their app view</Link>
                {!d.user_id && d.email && <button className="btn pri sm" onClick={() => invite(d.id)}>Invite</button>}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="card flush">
        <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Prop account purchases</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Registered to A+ Tradeplay · fees as entered</span></div>
        {(purchases.rows ?? []).length === 0 ? <div style={{ padding: 16 }}><Empty>No purchases</Empty></div> : (
          <Table head={["Order", "For investor", "Firm · plan", "Size", "Fee", "Paid by", "Bought", "Status"]} right={[3, 4]}>
            {(purchases.rows ?? []).map((p) => (
              <tr key={p.id}>
                <td className="mono faint">{p.ref}</td><td>{name(p.investor_id)}</td><td>{p.firm} · {p.plan}</td>
                <td className="r mono">{money(Number(p.size), "USD", 0)}</td><td className="r mono">{p.fee !== null ? money(Number(p.fee)) : "—"}</td>
                <td>{p.paid_by === "investor" ? "Investor transfer" : "A+ Tradeplay"}</td>
                <td className="mono faint">{dateShort((p as unknown as { purchased_at: string | null }).purchased_at)}</td>
                <td>
                  <select className={`chip ${P_TONE[p.status]}`} aria-label="Purchase status" value={p.status} onChange={(e) => setPurchase(p.id, e.target.value)}>
                    {["to_purchase", "evaluation", "funded", "breached", "refunded", "closed"].map((s) => <option key={s} value={s}>{label(s)}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {modal === "inv" && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Add investor">
          <form className="card" onSubmit={addInvestor}>
            <div className="ch"><h3>Add investor</h3><span className="sp" /><button type="button" className="btn ghost sm" onClick={() => setModal(null)}>Close</button></div>
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
              <label className="fld"><span>Name</span><div className="inp txt"><input value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} /></div></label>
              <label className="fld"><span>Email</span><div className="inp txt"><input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></div></label>
              <label className="fld"><span>Model</span><div className="inp"><select value={inv.model} onChange={(e) => setInv({ ...inv, model: e.target.value })}>{Object.entries(MODEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div></label>
              <label className="fld"><span>Fee</span><div className="inp"><input inputMode="decimal" value={inv.fee} onChange={(e) => setInv({ ...inv, fee: e.target.value })} /><span className="u">%</span></div></label>
            </div>
            <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}><button className="btn pri">Save</button></div>
          </form>
        </div>
      )}
      {modal === "pp" && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Record purchase">
          <form className="card" onSubmit={addPurchase}>
            <div className="ch"><h3>Record prop purchase</h3><span className="sp" /><button type="button" className="btn ghost sm" onClick={() => setModal(null)}>Close</button></div>
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))" }}>
              <label className="fld"><span>Investor</span><div className="inp"><select value={pp.investor_id} onChange={(e) => setPp({ ...pp, investor_id: e.target.value })}><option value="">—</option>{list.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div></label>
              <label className="fld"><span>Firm</span><div className="inp"><select value={pp.firm} onChange={(e) => setPp({ ...pp, firm: e.target.value })}>{["FundedHive", "The5ers", "Breakout", "FundedIN", "Other"].map((f) => <option key={f}>{f}</option>)}</select></div></label>
              <label className="fld"><span>Plan</span><div className="inp txt"><input value={pp.plan} onChange={(e) => setPp({ ...pp, plan: e.target.value })} /></div></label>
              <label className="fld"><span>Size</span><div className="inp"><input inputMode="decimal" value={pp.size} onChange={(e) => setPp({ ...pp, size: e.target.value })} /><span className="u">USD</span></div></label>
              <label className="fld"><span>Fee</span><div className="inp"><input inputMode="decimal" value={pp.fee} onChange={(e) => setPp({ ...pp, fee: e.target.value })} /><span className="u">USD</span></div></label>
              <label className="fld"><span>Paid by</span><div className="inp"><select value={pp.paid_by} onChange={(e) => setPp({ ...pp, paid_by: e.target.value })}><option value="investor">Investor transfer</option><option value="aplus">A+ Tradeplay</option></select></div></label>
            </div>
            <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}><button className="btn pri">Save</button></div>
          </form>
        </div>
      )}
    </>
  );
}
