"use client";

import { Suspense } from "react";
import { rooms } from "@/lib/accounts";
import { useInvestor } from "@/lib/useInvestor";
import { dateShort, money, num, pct } from "@/lib/fmt";
import { Bar, Card, Chip, Empty, ErrorNote } from "@/components/ui";
import InvestorPicker from "@/components/InvestorPicker";

const POLICY: Record<string, string> = { AUTO: "Copied automatically", CONFIRM: "Copied after confirmation", MANUAL: "Placed by hand", PAPER: "Paper (not live)", BLOCKED: "Paused" };

function Accounts() {
  const d = useInvestor();
  const rate = d.investor ? Number(d.investor.fee_rate) : 0.2;
  if (d.loading) return <Empty>Loading…</Empty>;
  return (
    <>
      <InvestorPicker investors={d.investors} current={d.investor?.id ?? null} />
      <ErrorNote error={d.error} />
      <section className="g12">
        {d.accounts.length === 0 && <div className="s12"><Empty>No accounts yet</Empty></div>}
        {d.accounts.map((a) => {
          const r = a.firm_rules ?? {};
          const start = Number(a.start_balance), eq = Number(a.equity);
          const base = r.profit_target_pct ? start : Number(a.hwm ?? start);
          const profit = eq - base;
          const split = r.split ?? 1;
          const share = Math.max(0, profit) * split * (1 - rate);
          const pp = d.purchases.find((p) => p.account_id === a.id);
          const stage = pp?.status ?? (r.profit_target_pct ? "evaluation" : "managed");
          const room = rooms(a);
          const target = r.profit_target_pct ? (start * r.profit_target_pct) / 100 : null;
          const floor = r.max_loss_pct ? start * (1 - r.max_loss_pct / 100) : null;
          return (
            <div key={a.id} className="card s6" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="between"><div className="col" style={{ gap: 2 }}><b style={{ fontSize: 16 }}>{a.name}</b><span className="faint" style={{ fontSize: 12 }}>{a.venue}{pp ? ` · ${pp.plan}` : ""} · registered to A+ Tradeplay</span></div><Chip tone={stage === "funded" ? "up" : stage === "breached" ? "down" : stage === "managed" ? "acc" : "info"}>{stage.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}</Chip></div>
              <div className="auto-s" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                <div><div className="lbl">Balance</div><b className="mono">{money(Number(a.balance), a.currency)}</b></div>
                <div><div className="lbl">Profit this cycle</div><b className={`mono ${profit >= 0 ? "up" : "down"}`}>{profit >= 0 ? "+" : ""}{money(profit, a.currency)}</b></div>
                <div><div className="lbl">Your share</div><b className="mono">{money(share, a.currency)}</b></div>
              </div>
              {target !== null && <div className="col" style={{ gap: 5 }}><div className="between" style={{ fontSize: 12 }}><span className="muted">Profit target · {r.profit_target_pct}%</span><span className="mono">{money(Math.max(0, eq - start), a.currency, 0)} / {money(target, a.currency, 0)}</span></div><Bar pct={(Math.max(0, eq - start) / target) * 100} /></div>}
              {room.dailyLossRoom !== undefined && <div className="col" style={{ gap: 5 }}><div className="between" style={{ fontSize: 12 }}><span className="muted">Daily loss room</span><span className="mono">{money(room.dailyLossRoom, a.currency)}</span></div><Bar pct={(room.dailyLossRoom / ((start * r.daily_loss_pct!) / 100)) * 100} tone="up" /></div>}
              {floor !== null && room.maxLossRoom !== undefined && <div className="col" style={{ gap: 5 }}><div className="between" style={{ fontSize: 12 }}><span className="muted">Overall loss room · floor {money(floor, a.currency)}</span><span className="mono">{money(room.maxLossRoom, a.currency)}</span></div><Bar pct={(room.maxLossRoom / (start - floor)) * 100} tone={room.maxLossRoom / (start - floor) < 0.35 ? "down" : "up"} /></div>}
              <div className="divider" />
              <div className="col" style={{ gap: 6, fontSize: 12.5 }}>
                <div className="between"><span className="muted">How it&apos;s traded</span><span>{POLICY[a.copy_policy] ?? a.copy_policy}</span></div>
                <div className="between"><span className="muted">Risk per trade</span><span className="mono">{num(Number(a.risk_pct), 2)}% of balance</span></div>
                <div className="between"><span className="muted">Fee</span><span>{r.split ? `${pct(rate, 0)} of each firm payout` : `${pct(rate, 0)} of profit above the high-water mark`}</span></div>
              </div>
            </div>
          );
        })}
      </section>

      {d.purchases.map((p) => {
        const a = d.accounts.find((x) => x.id === p.account_id);
        const pays = d.payouts.filter((x) => x.account_id === p.account_id && x.status === "paid");
        const events = [
          { e: `Order ${p.ref} · ${p.firm} ${p.plan} ${money(Number(p.size), "USD", 0)}`, d: p.created_at, c: "acc" },
          ...((p as unknown as { payment_received_at: string | null }).payment_received_at ? [{ e: "Payment received", d: (p as unknown as { payment_received_at: string }).payment_received_at, c: "acc" }] : []),
          ...((p as unknown as { purchased_at: string | null }).purchased_at ? [{ e: "Account purchased · evaluation started", d: (p as unknown as { purchased_at: string }).purchased_at, c: "acc" }] : []),
          ...(p.status === "funded" ? [{ e: "Funded", d: null, c: "up" }] : p.status === "breached" ? [{ e: "Breached", d: null, c: "down" }] : []),
          ...pays.map((x) => ({ e: `Payout ${x.period} · ${money(Number(x.to_investor))} to you`, d: x.paid_at, c: "up" })),
        ];
        return (
          <Card key={p.id} title={`Account timeline · ${a?.name ?? `${p.firm} ${money(Number(p.size), "USD", 0)}`}`}>
            {events.map((t, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "14px minmax(0,1fr) auto", gap: 10, alignItems: "start", padding: "8px 0", fontSize: 12.5 }}>
                <span className={`dot ${t.c}`} style={{ marginTop: 5 }} /><span>{t.e}</span><span className="mono faint" style={{ fontSize: 11.5 }}>{t.d ? dateShort(t.d) : ""}</span>
              </div>
            ))}
          </Card>
        );
      })}
    </>
  );
}

export default function Page() { return <Suspense><Accounts /></Suspense>; }
