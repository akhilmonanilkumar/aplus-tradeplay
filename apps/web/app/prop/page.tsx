"use client";

import Link from "next/link";
import { EDGE_RULES } from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import { rooms } from "@/lib/accounts";
import { istDay } from "@/lib/derive";
import type { PropPurchase, Trade, TradingAccount } from "@/lib/types";
import { money, num, pct } from "@/lib/fmt";
import { Bar, Chip, Empty, ErrorNote, Table } from "@/components/ui";

const PROP_VENUES = new Set(["The5ers", "FundedHive", "FundedIN", "Breakout"]);
const RULE_LABEL: Record<string, { t: string; tone: "up" | "warn" | "down" }> = {
  allowed: { t: "Copying allowed", tone: "up" },
  own_only: { t: "Own accounts only", tone: "warn" },
  banned: { t: "Appears banned", tone: "down" },
};

export default function Prop() {
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const trades = useRows<Trade>({ table: "trades", select: "id,account_id,pnl,opened_at,closed_at", limit: 3000 });
  const purchases = useRows<PropPurchase>({ table: "prop_purchases", order: "created_at" });
  const acc = (accounts.rows ?? []).filter((a) => PROP_VENUES.has(a.venue) || a.type === "eval" || a.firm_rules?.profit_target_pct);

  return (
    <>
      <ErrorNote error={accounts.error} />
      <section className="auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))" }}>
        {acc.map((a) => {
          const start = Number(a.start_balance), eq = Number(a.equity), pnl = eq - start;
          const r = a.firm_rules ?? {};
          const target = r.profit_target_pct ? (start * r.profit_target_pct) / 100 : null;
          const floor = r.max_loss_pct ? start * (1 - r.max_loss_pct / 100) : null;
          const room = rooms(a);
          const tAcc = (trades.rows ?? []).filter((t) => t.account_id === a.id);
          const days = new Set(tAcc.map((t) => istDay(t.opened_at))).size;
          const greenDays = new Set(tAcc.filter((t) => Number(t.pnl) > 0 && t.closed_at).map((t) => istDay(t.closed_at!))).size;
          const riskAmt = (Number(a.balance) * Number(a.risk_pct)) / 100;
          const need = target !== null && pnl < target ? Math.ceil((target - Math.max(0, pnl)) / (0.4 * riskAmt)) : 0;
          const pp = (purchases.rows ?? []).find((p) => p.account_id === a.id);
          const phase = pp?.status ?? (a.type === "eval" ? "evaluation" : "funded");
          return (
            <div key={a.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="between"><div className="col" style={{ gap: 2 }}><b style={{ fontSize: 15 }}>{a.name}</b><span className="faint" style={{ fontSize: 12 }}>{a.venue}{pp ? ` · ${pp.plan}` : ""}</span></div><Chip tone={phase === "funded" ? "up" : phase === "breached" ? "down" : "acc"}>{phase.replace("_", " ")}</Chip></div>
              <div className="auto-s" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                <div><div className="lbl">Balance</div><b className="mono">{money(Number(a.balance), a.currency)}</b></div>
                <div><div className="lbl">P&amp;L</div><b className={`mono ${pnl >= 0 ? "up" : "down"}`}>{pnl >= 0 ? "+" : ""}{money(pnl, a.currency)}</b></div>
                <div><div className="lbl">Days</div><b className="mono">{days}{greenDays ? ` · ${greenDays} green` : ""}</b></div>
              </div>
              {target !== null && <div className="col" style={{ gap: 5 }}><div className="between" style={{ fontSize: 12 }}><span className="muted">Profit target · {r.profit_target_pct}%</span><span className="mono">{money(Math.max(0, pnl), a.currency, 0)} / {money(target, a.currency, 0)}</span></div><Bar pct={(Math.max(0, pnl) / target) * 100} /></div>}
              {room.dailyLossRoom !== undefined && <div className="col" style={{ gap: 5 }}><div className="between" style={{ fontSize: 12 }}><span className="muted">Daily loss · {r.daily_loss_pct}%</span><span className="mono">{money(room.dailyLossRoom, a.currency)} left</span></div><Bar pct={(room.dailyLossRoom / ((start * r.daily_loss_pct!) / 100)) * 100} tone="up" /></div>}
              {floor !== null && room.maxLossRoom !== undefined && <div className="col" style={{ gap: 5 }}><div className="between" style={{ fontSize: 12 }}><span className="muted">Max loss · {r.max_loss_pct}%</span><span className="mono">floor {money(floor, a.currency)}</span></div><Bar pct={(room.maxLossRoom / (start - floor)) * 100} tone="up" /></div>}
              <div className="divider" />
              <div className="col" style={{ gap: 6, fontSize: 12 }}>
                <div className="between"><span className="muted">Plan risk per trade</span><span className="mono">{num(Number(a.risk_pct), 2)}% · {money(riskAmt, a.currency)}</span></div>
                {target !== null && <div className="between"><span className="muted">Trades to target at +0.40R</span><span className="mono">{pnl >= target ? "target met" : need}</span></div>}
                {r.split && <div className="between"><span className="muted">Payout split</span><span className="mono">{pct(r.split, 0)}</span></div>}
                <div className="between"><span className="muted">Firm copy rule</span><span className="mono">{r.copy_rule ? RULE_LABEL[r.copy_rule]?.t ?? r.copy_rule : "not set"}</span></div>
              </div>
              <div className="between"><Chip tone={a.is_live ? "up" : "warn"}>{a.is_live ? "Synced from venue" : "Manual balance"}</Chip><Link className="btn ghost sm" href="/accounts">Edit</Link></div>
            </div>
          );
        })}
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 14, borderStyle: "dashed", background: "transparent" }}>
          <div className="col" style={{ gap: 2 }}><b style={{ fontSize: 15 }}>Add a challenge</b><span className="faint" style={{ fontSize: 12 }}>Balance- or equity-based limits, static or trailing drawdown</span></div>
          <p className="muted" style={{ fontSize: 12.5 }}>Personal guardrails are set tighter than the firm: daily loss ≤ {EDGE_RULES.dailyLossCapPct}%, daily profit cap {EDGE_RULES.challengeDailyProfitCapPct}% on challenges, 0.5% risk.</p>
          <Link className="btn sm" style={{ alignSelf: "flex-start" }} href="/accounts">Set up rules</Link>
        </div>
      </section>

      <section className="card flush">
        <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Rule sheet</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Rules on file</span></div>
        {acc.length === 0 ? <div style={{ padding: 16 }}><Empty>No challenges yet</Empty></div> : (
          <Table head={["Rule", ...acc.map((a) => a.name)]}>
            {([
              ["Profit target", (a: TradingAccount) => (a.firm_rules?.profit_target_pct ? `${a.firm_rules.profit_target_pct}%` : "—")],
              ["Daily loss", (a: TradingAccount) => (a.firm_rules?.daily_loss_pct ? `${a.firm_rules.daily_loss_pct}%` : "—")],
              ["Max loss", (a: TradingAccount) => (a.firm_rules?.max_loss_pct ? `${a.firm_rules.max_loss_pct}%` : "—")],
              ["Payout split", (a: TradingAccount) => (a.firm_rules?.split ? pct(a.firm_rules.split, 0) : "—")],
            ] as const).map(([k, f]) => (
              <tr key={k}><td className="muted">{k}</td>{acc.map((a) => <td key={a.id} className="mono">{f(a)}</td>)}</tr>
            ))}
            <tr><td className="muted">Copy between own accounts</td>{acc.map((a) => { const x = a.firm_rules?.copy_rule ? RULE_LABEL[a.firm_rules.copy_rule] : null; return <td key={a.id}>{x ? <Chip tone={x.tone}>{x.t}</Chip> : <Chip>verify</Chip>}</td>; })}</tr>
            <tr><td className="muted">Sync method</td>{acc.map((a) => <td key={a.id}>{a.is_live ? "Venue API" : "Manual entry"}</td>)}</tr>
          </Table>
        )}
      </section>
    </>
  );
}
