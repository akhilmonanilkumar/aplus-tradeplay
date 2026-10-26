"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { CashFlow, Snapshot, TradingAccount } from "@/lib/types";
import { dateShort, money, pct, signed } from "@/lib/fmt";
import { Card, Empty, Table } from "@/components/ui";

const SIGN: Record<CashFlow["kind"], number> = { deposit: 1, withdrawal: -1, payout: -1, fee: -1, adjustment: 0 };

/**
 * How an investor's money has grown: combined equity over time from balance snapshots,
 * net of deposits and withdrawals, with a monthly breakdown (money-weighted, flows excluded).
 */
export default function InvestorGrowth({ accounts }: { accounts: TradingAccount[] }) {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [flows, setFlows] = useState<CashFlow[]>([]);
  const ids = accounts.filter((a) => a.currency !== "INR").map((a) => a.id);
  const key = ids.join(",");
  useEffect(() => {
    if (!ids.length) return;
    Promise.all([
      supabase.from("account_snapshots").select("*").in("account_id", ids).order("at").limit(10000),
      supabase.from("cash_flows").select("*").in("account_id", ids).order("at").limit(5000),
    ]).then(([s, f]) => { setSnaps((s.data ?? []) as Snapshot[]); setFlows((f.data ?? []) as CashFlow[]); });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ids.length) return null;
  // Combined equity after each snapshot: carry each account's latest equity forward.
  const last = new Map<string, number>();
  const points: { t: number; v: number }[] = [];
  for (const s of snaps) { last.set(s.account_id, Number(s.equity)); points.push({ t: +new Date(s.at), v: [...last.values()].reduce((a, b) => a + b, 0) }); }
  const value = accounts.filter((a) => ids.includes(a.id)).reduce((s, a) => s + Number(a.equity), 0);
  const netDep = flows.reduce((s, f) => s + SIGN[f.kind] * Number(f.amount), 0);
  const growth = netDep > 0 ? (value - netDep) / netDep : null;

  // Monthly: end equity − start equity − net flows in the month.
  const months = new Map<string, { start: number; end: number; flows: number }>();
  for (const p of points) {
    const k = new Date(p.t).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
    const m = months.get(k);
    if (!m) months.set(k, { start: [...months.values()].at(-1)?.end ?? p.v, end: p.v, flows: 0 });
    else m.end = p.v;
  }
  for (const f of flows) { const k = new Date(f.at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7); const m = months.get(k); if (m) m.flows += SIGN[f.kind] * Number(f.amount); }

  const W = 800, H = 180;
  const vals = points.map((p) => p.v);
  const lo = Math.min(...vals, netDep > 0 ? netDep : Infinity), hi = Math.max(...vals), sp = hi - lo || 1;
  const x = (i: number) => (i / Math.max(1, vals.length - 1)) * W;
  const y = (v: number) => H - 8 - ((v - lo) / sp) * (H - 16);
  const path = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <section className="g12">
      <Card span={8} title="How your money has grown" right={<span className={`mono ${growth !== null ? signed(growth) : ""}`} style={{ fontSize: 13 }}>{growth !== null ? `${growth >= 0 ? "+" : ""}${pct(growth, 2)} on ${money(netDep, "USD", 0)} invested` : ""}</span>}>
        {vals.length < 2 ? <Empty>Growth appears after the first balance updates</Empty> : (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 180, display: "block" }} role="img" aria-label="Account value over time">
            {netDep > 0 && <line x1="0" x2={W} y1={y(netDep)} y2={y(netDep)} stroke="var(--faint)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
            <path d={`${path} L${W},${H} L0,${H} Z`} fill="var(--accent-bg)" />
            <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <p className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>Solid line: combined account value. Dashed: what you put in (deposits − withdrawals). Updated whenever a balance changes.</p>
      </Card>
      <Card span={4} title="By month">
        {months.size === 0 ? <Empty>No history yet</Empty> : (
          <Table head={["Month", "Gain", "Return"]} right={[1, 2]}>
            {[...months].reverse().slice(0, 12).map(([k, m]) => {
              const gain = m.end - m.start - m.flows;
              const base = m.start + Math.max(0, m.flows);
              return <tr key={k}><td className="mono">{k}</td><td className={`r mono ${signed(gain)}`}>{money(gain, "USD", 0)}</td><td className={`r mono ${signed(gain)}`}>{base > 0 ? pct(gain / base, 2) : "—"}</td></tr>;
            })}
          </Table>
        )}
        {flows.length > 0 && <p className="faint" style={{ fontSize: 11, marginTop: 8 }}>Last movement: {flows.at(-1)!.kind} {money(Number(flows.at(-1)!.amount))} on {dateShort(flows.at(-1)!.at)}</p>}
      </Card>
    </section>
  );
}
