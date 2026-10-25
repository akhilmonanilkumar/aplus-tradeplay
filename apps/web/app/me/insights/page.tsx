"use client";

import { Suspense, useMemo } from "react";
import { hwmFee, summarize } from "@aplus/engine";
import { useInvestor } from "@/lib/useInvestor";
import { equitySeries } from "@/lib/derive";
import { money, num, pct } from "@/lib/fmt";
import { Bar, Card, Chip, Empty, ErrorNote } from "@/components/ui";
import InvestorPicker from "@/components/InvestorPicker";
import TradeLog from "@/components/TradeLog";

function Insights() {
  const d = useInvestor();
  const rate = d.investor ? Number(d.investor.fee_rate) : 0.2;
  const usd = d.accounts.filter((a) => a.currency !== "INR");
  const s90 = useMemo(() => equitySeries(usd, d.trades, "combined", 90), [usd, d.trades]);
  const closed = d.trades.filter((t) => t.realized_r !== null);
  const st = summarize(closed.map((t) => Number(t.realized_r)).reverse());
  const total = usd.reduce((s, a) => s + Number(a.equity), 0);

  // monthly return: month P&L ÷ value at the start of that month
  const months = Array.from({ length: 3 }, (_, i) => { const x = new Date(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() - i); return x.toISOString().slice(0, 7); }).reverse();
  const monthly = months.map((m) => {
    const pnl = d.trades.filter((t) => t.closed_at?.startsWith(m) && t.pnl !== null).reduce((s, t) => s + Number(t.pnl), 0);
    const later = d.trades.filter((t) => t.closed_at && t.closed_at.slice(0, 7) >= m && t.pnl !== null).reduce((s, t) => s + Number(t.pnl), 0);
    const startVal = total - later;
    return { m: new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }), r: startVal > 0 ? pnl / startVal : null };
  });

  const pending = d.payouts.filter((p) => p.status === "pending" || p.status === "approved").reduce((s, p) => s + Number(p.to_investor), 0);
  const managed = d.accounts.filter((a) => a.hwm !== null && !a.firm_rules?.profit_target_pct);
  const above = managed.reduce((s, a) => s + Math.max(0, Number(a.equity) - Number(a.hwm)), 0);
  const accrued = managed.reduce((s, a) => s + hwmFee({ navEnd: Number(a.equity), hwm: Number(a.hwm), rate }).fee, 0);
  const funded = d.purchases.filter((p) => p.status === "funded").length, inEval = d.purchases.filter((p) => p.status === "evaluation").length;
  const week = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const last30 = closed.filter((t) => +new Date(t.closed_at ?? t.opened_at) >= Date.now() - 30 * 86_400_000);
  const s30 = summarize(last30.map((t) => Number(t.realized_r)));

  // chart
  const W = 800, H = 200, v = s90.vals;
  const lo = Math.min(...v), hi = Math.max(...v), sp = hi - lo || Math.max(1, hi * 0.01);
  const line = v.map((y, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * W).toFixed(1)},${(H - 10 - ((y - lo) / sp) * (H - 20)).toFixed(1)}`).join(" ");

  if (d.loading) return <Empty>Loading…</Empty>;
  return (
    <>
      <InvestorPicker investors={d.investors} current={d.investor?.id ?? null} />
      <ErrorNote error={d.error} />
      <section className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))" }}>
        {[
          { l: "Value", v: money(total), n: `${usd.length} account${usd.length === 1 ? "" : "s"}`, c: "" },
          { l: "90-day return", v: `${s90.ret >= 0 ? "+" : ""}${pct(s90.ret, 2)}`, n: "all accounts", c: s90.ret >= 0 ? "up" : "down" },
          { l: "Win rate", v: st.n ? pct(st.winRate, 0) : "—", n: `${st.n} trades`, c: "" },
          { l: "Average result", v: st.n ? `${st.avgR >= 0 ? "+" : ""}${num(st.avgR, 2)}R` : "—", n: "per trade", c: st.avgR >= 0 ? "up" : "down" },
          { l: "Largest dip", v: pct(s90.maxDd, 2), n: "peak to trough · 90 d", c: "" },
        ].map((k) => <div key={k.l} className="card"><div className="lbl">{k.l}</div><div className={`kv sm ${k.c}`} style={{ marginTop: 4 }}>{k.v}</div><div className="faint" style={{ fontSize: 11 }}>{k.n}</div></div>)}
      </section>

      <section className="g12">
        <Card span={7} title={`Outlook · ${week}`} right={<Chip tone="acc">from your accounts</Chip>}>
          <div className="col" style={{ gap: 10, fontSize: 13.5, lineHeight: 1.6 }}>
            <p>{last30.length ? `In the last 30 days your accounts took ${last30.length} trade${last30.length === 1 ? "" : "s"}: ${s30.wins} won, ${s30.losses} lost, net ${s30.netR >= 0 ? "+" : ""}${num(s30.netR, 2)}R.` : "No trades closed in the last 30 days."} Only setups that pass all seven A+ checks are taken, with at most two a day per instrument.</p>
            <p className="muted">{funded ? `${funded} funded account${funded > 1 ? "s" : ""}` : ""}{funded && inEval ? " and " : ""}{inEval ? `${inEval} in evaluation` : ""}{funded || inEval ? ". " : ""}{pending ? `A payout of ${money(pending)} is on its way to you.` : "No payout pending right now."}</p>
            <p className="muted">{managed.length ? (above > 0 ? `Your managed account is ${money(above)} above its high-water mark, so a fee of ${money(accrued)} would apply if the month closed today.` : "Your managed account is at or below its high-water mark, so no fee is due.") : ""} US clocks change on 1 Nov; nothing changes for you.</p>
            <span className="faint" style={{ fontSize: 11.5 }}>Educational summary, not financial advice.</span>
          </div>
        </Card>
        <Card span={5} title="Where your money is">
          {usd.length === 0 ? <Empty>No accounts yet</Empty> : usd.map((a) => (
            <div key={a.id} style={{ display: "grid", gridTemplateColumns: "150px minmax(0,1fr) 70px", gap: 10, alignItems: "center", fontSize: 12.5, padding: "6px 0" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span><Bar pct={total ? (Number(a.equity) / total) * 100 : 0} /><span className="mono" style={{ textAlign: "right" }}>{total ? pct(Number(a.equity) / total, 0) : "—"}</span>
            </div>
          ))}
          <div className="divider" style={{ margin: "12px 0" }} />
          <div className="lbl-u" style={{ marginBottom: 6 }}>Monthly return</div>
          {monthly.map((m) => <div key={m.m} className="between" style={{ fontSize: 12.5, padding: "4px 0" }}><span className="muted">{m.m}</span><span className={`mono ${m.r === null ? "" : m.r >= 0 ? "up" : "down"}`}>{m.r === null ? "—" : `${m.r >= 0 ? "+" : ""}${pct(m.r, 2)}`}</span></div>)}
        </Card>
      </section>

      <Card title="Combined value · your accounts" right={<span className="faint mono" style={{ fontSize: 12 }}>{money(s90.start)} → {money(s90.end)}</span>}>
        {usd.length === 0 ? <Empty>No accounts yet</Empty> : (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 200, display: "block" }} role="img" aria-label="Combined value over 90 days">
            <path d={`${line} L${W},${H} L0,${H} Z`} fill="var(--accent-bg)" />
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </Card>

      <TradeLog trades={d.trades} accounts={d.accounts} limit={20} />
    </>
  );
}

export default function Page() { return <Suspense><Insights /></Suspense>; }
