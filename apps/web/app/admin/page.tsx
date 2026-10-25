"use client";

import { useEffect, useMemo, useState } from "react";
import { hwmFee, propPayout } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { Investor, Payout, TradingAccount } from "@/lib/types";
import { dateShort, money, pct, toNum } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote, Note, Seg, Table } from "@/components/ui";

type Member = { user_id: string; role: string; display_name: string; created_at: string };
type Audit = { id: number; at: string; actor: string | null; action: string; entity: string; entity_id: string | null };
type Hook = { name: string; last_status: string | null; enabled: boolean };
const RULE_POLICY: Record<string, { own: string; eval: string; investor: string }> = {
  allowed: { own: "AUTO", eval: "AUTO", investor: "CONFIRM" },
  own_only: { own: "AUTO", eval: "CONFIRM", investor: "BLOCKED" },
  banned: { own: "MANUAL", eval: "MANUAL", investor: "BLOCKED" },
};
const PT: Record<string, "up" | "info" | "warn" | "down" | ""> = { AUTO: "up", CONFIRM: "info", MANUAL: "warn", PAPER: "", BLOCKED: "down" };

function Health() {
  const [rows, setRows] = useState<{ n: string; ok: boolean | null; v: string }[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const t0 = performance.now();
      const db = await supabase.from("app_settings").select("id").limit(1);
      const dbMs = Math.round(performance.now() - t0);
      const probe = async (url: string) => { const t = performance.now(); try { const r = await fetch(url, { cache: "no-store" }); return { ok: r.ok, ms: Math.round(performance.now() - t) }; } catch { return { ok: false, ms: 0 }; } };
      const [btc, gold, api] = await Promise.all([
        probe("https://fapi.binance.com/fapi/v1/time"),
        probe("https://api.binance.com/api/v3/time"),
        probe("/api/health"),
      ]);
      if (live) setRows([
        { n: "Supabase · database + auth", ok: !db.error, v: db.error ? db.error.message : `${dbMs} ms` },
        { n: "Market data · Binance USDⓈ-M (BTC mark)", ok: btc.ok, v: btc.ok ? `${btc.ms} ms` : "unreachable" },
        { n: "Gold feed · PAXG proxy (Binance spot)", ok: gold.ok, v: gold.ok ? `${gold.ms} ms` : "unreachable" },
        { n: "Rule engine · closed-candle evaluator v1.1", ok: true, v: "in browser" },
        { n: "App · Vercel", ok: api.ok, v: api.ok ? `${api.ms} ms` : "down" },
      ]);
    })();
    return () => { live = false; };
  }, []);
  return <>{rows.length === 0 ? <Empty>Checking…</Empty> : rows.map((r) => (
    <div key={r.n} style={{ display: "grid", gridTemplateColumns: "10px minmax(0,1fr) auto", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
      <span className={`dot ${r.ok ? "up" : r.ok === false ? "down" : "warn"}`} /><span>{r.n}</span><span className="mono faint">{r.v}</span>
    </div>
  ))}</>;
}

export default function Admin() {
  const me = useMe();
  const members = useRows<Member>({ table: "members", order: "created_at", ascending: true });
  const investors = useRows<Investor>({ table: "investors", order: "created_at", ascending: true });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,venue,type,investor_id,equity,hwm,start_balance,firm_rules,currency" });
  const payouts = useRows<Payout>({ table: "payouts", order: "created_at" });
  const audit = useRows<Audit>({ table: "audit_log", select: "id,at,actor,action,entity,entity_id", order: "at", limit: 30 });
  const hooks = useRows<Hook>({ table: "webhooks_out", select: "name,last_status,enabled" });
  const [kind, setKind] = useState<"prop" | "hwm">("prop");
  const [f, setF] = useState({ investor_id: "", account_id: "", period: new Date().toISOString().slice(0, 7), profit: "", split: "80", nav: "", hwm: "" });
  const [approving, setApproving] = useState<Payout | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [factors, setFactors] = useState<string>("—");
  useEffect(() => { supabase.auth.mfa.listFactors().then(({ data }) => setFactors(data?.totp.some((x) => x.status === "verified") ? "TOTP" : "Not set")); }, []);

  const invs = investors.rows ?? [], accs = accounts.rows ?? [], pays = payouts.rows ?? [];
  const inv = invs.find((i) => i.id === f.investor_id);
  const rate = inv ? Number(inv.fee_rate) : 0.2;
  const invName = (id: string) => invs.find((i) => i.id === id)?.name ?? "—";
  const accName = (id: string | null) => accs.find((a) => a.id === id)?.name ?? "";
  const pending = pays.filter((p) => p.status === "pending");
  const invited = invs.filter((i) => i.email && !i.user_id);
  const badHooks = (hooks.rows ?? []).filter((h) => h.enabled && h.last_status && !h.last_status.startsWith("2"));

  const calc = useMemo(() => {
    try {
      if (kind === "prop") {
        const profit = toNum(f.profit), split = toNum(f.split) / 100;
        if (!(profit >= 0) || !(split > 0 && split <= 1)) return null;
        const p = propPayout({ profit, firmSplit: split, ourRate: rate });
        return { gross: profit, firm_split: split, hwm_before: null as number | null, commission: p.commission, to_investor: p.toInvestor, lines: [["Profit on funded account", money(profit)], [`Firm keeps ${pct(1 - split, 0)}`, `−${money(p.firmKeeps)}`], ["Firm pays out", money(p.firmPays)], [`A+ commission ${pct(rate, 0)}`, `−${money(p.commission)}`]] };
      }
      const nav = toNum(f.nav), hwm = toNum(f.hwm);
      if (!(nav > 0) || !(hwm > 0)) return null;
      const h = hwmFee({ navEnd: nav, hwm, rate });
      return { gross: h.above, firm_split: null, hwm_before: hwm, commission: h.fee, to_investor: h.toInvestor, lines: [["NAV at period end", money(nav)], ["High-water mark", money(hwm)], ["Profit above HWM", money(h.above)], [`Performance fee ${pct(rate, 0)}`, `−${money(h.fee)}`]] };
    } catch { return null; }
  }, [kind, f, rate]);

  const pick = (id: string) => {
    const a = accs.find((x) => x.id === id);
    setF({ ...f, account_id: id, split: a?.firm_rules?.split ? String(a.firm_rules.split * 100) : f.split, nav: a ? String(a.equity) : f.nav, hwm: a ? String(a.hwm ?? a.start_balance) : f.hwm });
  };
  const record = async () => {
    if (!calc || !inv) return;
    if (calc.gross <= 0) return setMsg({ ok: false, t: "Nothing above the high-water mark" });
    const { error } = await supabase.from("payouts").insert({ investor_id: inv.id, account_id: f.account_id || null, kind, period: f.period, gross: calc.gross, firm_split: calc.firm_split, hwm_before: calc.hwm_before, commission: calc.commission, to_investor: calc.to_investor });
    setMsg(error ? { ok: false, t: error.message } : { ok: true, t: "Payout recorded — approve below" });
    if (!error) { setF({ ...f, profit: "" }); payouts.reload(); }
  };
  const approve = async () => {
    if (!approving) return;
    const e = await me.stepUp(code);
    if (e) return setMsg({ ok: false, t: e });
    const { error } = await supabase.from("payouts").update({ status: "approved" }).eq("id", approving.id);
    setMsg(error ? { ok: false, t: error.message } : { ok: true, t: "Approved" });
    setApproving(null); setCode(""); payouts.reload();
  };
  const setStatus = async (id: string, status: Payout["status"]) => { await supabase.from("payouts").update({ status }).eq("id", id); payouts.reload(); };
  const flag = (p: Payout) => {
    const a = accs.find((x) => x.id === p.account_id);
    const rule = a?.firm_rules?.copy_rule;
    return a && (rule === "banned" || rule === "own_only") ? `${a.venue}'s terms appear to restrict accounts run for a third party. Approve only after review.` : null;
  };
  const venues = Array.from(new Set(accs.map((a) => a.venue)));
  const actor = (id: string | null) => (id ? (members.rows ?? []).find((m) => m.user_id === id)?.display_name || id.slice(0, 6) : "system");

  return (
    <>
      <ErrorNote error={members.error || payouts.error || audit.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="g12">
        <div className="card s3"><div className="lbl">Users</div><div className="kv" style={{ marginTop: 6 }}>{(members.rows ?? []).length}</div><div className="faint" style={{ fontSize: 12 }}>{(members.rows ?? []).filter((m) => m.role !== "investor").length} staff · {(members.rows ?? []).filter((m) => m.role === "investor").length} investors</div></div>
        <div className="card s3"><div className="lbl">Pending invites</div><div className="kv" style={{ marginTop: 6 }}>{invited.length}</div><div className="faint" style={{ fontSize: 12 }}>investors without a login</div></div>
        <div className="card s3"><div className="lbl">Payouts to approve</div><div className={`kv ${pending.length ? "warn" : ""}`} style={{ marginTop: 6 }}>{pending.length}</div><div className="faint" style={{ fontSize: 12 }}>{money(pending.reduce((s, p) => s + Number(p.to_investor), 0))} · needs 2FA</div></div>
        <div className="card s3"><div className="lbl">System</div><div className={`kv sm ${badHooks.length ? "warn" : "up"}`} style={{ marginTop: 6 }}>{badHooks.length ? "Degraded" : "All services up"}</div><div className="faint" style={{ fontSize: 12 }}>{badHooks.length ? `${badHooks.length} webhook failing` : "webhooks healthy"}</div></div>
      </section>

      <section className="card flush" id="users">
        <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Users</h3></div>
        <Table head={["User", "Role", "Accounts", "2FA", "Consent / mandate", "Status"]}>
          {(members.rows ?? []).map((m) => {
            const i = invs.find((x) => x.user_id === m.user_id);
            const self = m.user_id === me.session.user.id;
            return (
              <tr key={m.user_id}>
                <td><div className="row" style={{ flexWrap: "nowrap" }}><span className="ava" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>{(m.display_name || "?").slice(0, 2).toUpperCase()}</span><div className="col" style={{ gap: 1 }}><b style={{ fontWeight: 500 }}>{m.display_name || "—"}</b><span className="faint" style={{ fontSize: 11 }}>{self ? me.session.user.email : i?.email ?? ""}</span></div></div></td>
                <td><Chip tone={m.role === "owner" ? "acc" : m.role === "admin" ? "info" : ""}>{m.role.replace(/^\w/, (c) => c.toUpperCase())}</Chip></td>
                <td className="mono">{m.role === "investor" ? accs.filter((a) => a.investor_id === i?.id).length : accs.filter((a) => !a.investor_id).length}</td>
                <td>{self ? <Chip tone={factors === "TOTP" ? "up" : "warn"}>{factors}</Chip> : <span className="faint">{m.role === "investor" ? "optional" : "required"}</span>}</td>
                <td className="muted">{m.role === "investor" ? (i?.agreement_signed_at ? `Signed ${dateShort(i.agreement_signed_at)} · ${pct(Number(i.fee_rate), 0)}` : "Not signed") : m.role === "owner" ? "Owner" : "Staff"}</td>
                <td><Chip tone="up">Active</Chip></td>
              </tr>
            );
          })}
          {invited.map((i) => (
            <tr key={i.id}><td><div className="row" style={{ flexWrap: "nowrap" }}><span className="ava" style={{ background: "var(--surface-3)", color: "var(--muted)" }}>{i.name.slice(0, 2).toUpperCase()}</span><div className="col" style={{ gap: 1 }}><b style={{ fontWeight: 500 }}>{i.name}</b><span className="faint" style={{ fontSize: 11 }}>{i.email}</span></div></div></td><td><Chip>Investor</Chip></td><td className="mono">—</td><td><Chip tone="warn">Not set</Chip></td><td className="muted">{i.agreement_signed_at ? "Signed" : "Not signed"}</td><td><Chip tone="warn">No login</Chip></td></tr>
          ))}
        </Table>
      </section>

      <section className="g12">
        <div className="card flush s7" id="policy">
          <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Copy policy matrix</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Default per firm copy rule · set per account in Accounts</span></div>
          {venues.length === 0 ? <div style={{ padding: 16 }}><Empty>No venues yet</Empty></div> : (
            <Table head={["Venue", "Master / sub", "Own eval", "Demo", "Investor-assigned"]}>
              {venues.map((v) => {
                const rule = accs.find((a) => a.venue === v && a.firm_rules?.copy_rule)?.firm_rules?.copy_rule ?? "allowed";
                const p = v === "Breakout" ? { own: "MANUAL", eval: "MANUAL", investor: "MANUAL" } : RULE_POLICY[rule] ?? RULE_POLICY.allowed!;
                return <tr key={v}><td><b style={{ fontWeight: 500 }}>{v}</b></td><td><Chip tone={PT[p.own]}>{p.own}</Chip></td><td><Chip tone={PT[p.eval]}>{p.eval}</Chip></td><td><Chip>PAPER</Chip></td><td><Chip tone={PT[p.investor]}>{p.investor}</Chip></td></tr>;
              })}
            </Table>
          )}
        </div>
        <Card span={5} id="payouts" title="Payout approvals">
          {pending.length === 0 && <span className="faint" style={{ fontSize: 12.5 }}>Nothing waiting.</span>}
          <div className="col" style={{ gap: 10 }}>
            {pending.map((p) => (
              <div key={p.id} className="col" style={{ gap: 8 }}>
                <div className="between"><div className="col" style={{ gap: 2 }}><b style={{ fontSize: 13 }}>{invName(p.investor_id)}{p.account_id ? ` · ${accName(p.account_id)}` : ""}</b><span className="faint" style={{ fontSize: 11.5 }}>{p.kind === "prop" ? `Firm payout ${money(Number(p.gross) * Number(p.firm_split ?? 1))}` : `Above HWM ${money(Number(p.gross))}`} − commission {money(Number(p.commission))} · {p.period}</span></div><b className="mono up">{money(Number(p.to_investor))}</b></div>
                {flag(p) && <div className="banner warn" style={{ fontSize: 12 }}>Policy flag: {flag(p)}</div>}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}><button className="btn pri" onClick={() => setApproving(p)}>Approve with 2FA</button><button className="btn" onClick={() => setStatus(p.id, "held")}>Hold</button></div>
              </div>
            ))}
            {pays.filter((p) => p.status !== "pending").length > 0 && <div className="divider" />}
            {pays.filter((p) => p.status !== "pending").slice(0, 8).map((p) => (
              <div key={p.id} className="between" style={{ fontSize: 12.5 }}>
                <span className="muted">{invName(p.investor_id)} · {p.period}{p.account_id ? ` · ${accName(p.account_id)}` : ""}</span>
                {p.status === "approved" ? <button className="btn sm" onClick={() => setStatus(p.id, "paid")}>Mark paid {money(Number(p.to_investor))}</button> : p.status === "held" ? <button className="chip warn" onClick={() => setStatus(p.id, "pending")}>Held · release</button> : <Chip tone="up">Paid {money(Number(p.to_investor))}</Chip>}
              </div>
            ))}
          </div>
        </Card>
      </section>

      <section className="g12">
        <Card span={6} title="Record a payout" right={<Seg label="Kind" value={kind} onChange={setKind} options={[{ v: "prop", l: "Prop payout" }, { v: "hwm", l: "Managed · HWM" }]} />}>
          <div className="auto-s" style={{ gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
            <label className="fld"><span>Investor</span><div className="inp"><select value={f.investor_id} onChange={(e) => setF({ ...f, investor_id: e.target.value, account_id: "" })}><option value="">—</option>{invs.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></div></label>
            <label className="fld"><span>Account</span><div className="inp"><select value={f.account_id} onChange={(e) => pick(e.target.value)}><option value="">—</option>{accs.filter((a) => a.investor_id === f.investor_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div></label>
            <label className="fld"><span>Period</span><div className="inp"><input type="month" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })} /></div></label>
            {kind === "prop" ? (
              <>
                <label className="fld"><span>Profit</span><div className="inp"><input inputMode="decimal" value={f.profit} onChange={(e) => setF({ ...f, profit: e.target.value })} /><span className="u">USD</span></div></label>
                <label className="fld"><span>Firm split</span><div className="inp"><input inputMode="decimal" value={f.split} onChange={(e) => setF({ ...f, split: e.target.value })} /><span className="u">%</span></div></label>
              </>
            ) : (
              <>
                <label className="fld"><span>NAV at end</span><div className="inp"><input inputMode="decimal" value={f.nav} onChange={(e) => setF({ ...f, nav: e.target.value })} /><span className="u">USD</span></div></label>
                <label className="fld"><span>High-water mark</span><div className="inp"><input inputMode="decimal" value={f.hwm} onChange={(e) => setF({ ...f, hwm: e.target.value })} /><span className="u">USD</span></div></label>
              </>
            )}
            <label className="fld"><span>Our fee</span><div className="inp">{pct(rate, 0)}</div></label>
          </div>
          {calc && (
            <div style={{ marginTop: 12 }}>
              {calc.lines.map(([k, v]) => <div key={k} className="between" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}><span className="muted">{k}</span><span className="mono">{v}</span></div>)}
              <div className="between" style={{ padding: "8px 0", fontSize: 13 }}><b>To investor</b><b className="mono up">{money(calc.to_investor)}</b></div>
              <button className="btn pri sm" disabled={!inv} onClick={record}>Record payout</button>
            </div>
          )}
        </Card>
        <Card span={6} id="health" title="System health" right={<span className="faint" style={{ fontSize: 12 }}>Supabase · market data · Vercel</span>}>
          <Health />
          {(hooks.rows ?? []).map((h) => (
            <div key={h.name} style={{ display: "grid", gridTemplateColumns: "10px minmax(0,1fr) auto", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
              <span className={`dot ${!h.last_status ? "warn" : h.last_status.startsWith("2") ? "up" : "down"}`} /><span>Outbound webhook · {h.name}</span><span className="mono faint">{h.last_status ?? "not called yet"}</span>
            </div>
          ))}
        </Card>
      </section>

      <section className="card flush" id="audit">
        <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Audit log</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Append-only</span></div>
        {(audit.rows ?? []).length === 0 ? <div style={{ padding: 16 }}><Empty>No changes yet</Empty></div> : (
          <Table head={["Time (IST)", "Who", "Action"]}>
            {(audit.rows ?? []).map((a) => <tr key={a.id}><td className="mono faint">{new Date(a.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" })}</td><td>{actor(a.actor)}</td><td>{a.action} · {a.entity.replace(/_/g, " ")}{a.entity_id ? ` · ${a.entity_id.slice(0, 8)}` : ""}</td></tr>)}
          </Table>
        )}
      </section>

      {approving && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Approve payout">
          <div className="card">
            <div className="ch"><h3>Approve {money(Number(approving.to_investor))} to {invName(approving.investor_id)}</h3></div>
            {flag(approving) && <div className="banner warn" style={{ fontSize: 12, marginBottom: 10 }}>{flag(approving)}</div>}
            <label className="fld"><span>Authenticator code</span><div className="inp"><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus /></div></label>
            <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}><button className="btn" onClick={() => { setApproving(null); setCode(""); }}>Cancel</button><button className="btn pri" disabled={code.length !== 6} onClick={approve}>Approve</button></div>
          </div>
        </div>
      )}
    </>
  );
}
