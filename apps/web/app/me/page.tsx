"use client";

import Link from "next/link";
import { summarize } from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import { useMe } from "@/components/Shell";
import type { Payout, Trade, TradingAccount } from "@/lib/types";
import { money, pct, r, signed } from "@/lib/fmt";
import { Badge, Card, Empty, ErrorNote, Kpi, PageHead, Spark, Table } from "@/components/ui";
import AccountProgress from "@/components/AccountProgress";

const TONE: Record<Payout["status"], string> = { pending: "warn", approved: "accent", paid: "up", held: "down" };

export default function InvestorHome() {
  const me = useMe();
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", ascending: true, limit: 2000 });
  const payouts = useRows<Payout>({ table: "payouts", order: "created_at" });

  const acc = accounts.rows ?? [];
  const usd = acc.filter((a) => a.currency !== "INR");
  const equity = usd.reduce((s, a) => s + Number(a.equity), 0);
  const pnl = usd.reduce((s, a) => s + Number(a.equity) - Number(a.start_balance), 0);
  const pays = payouts.rows ?? [];
  const received = pays.filter((p) => p.status === "paid").reduce((s, p) => s + Number(p.to_investor), 0);
  const pending = pays.filter((p) => p.status === "pending" || p.status === "approved").reduce((s, p) => s + Number(p.to_investor), 0);
  const closed = (trades.rows ?? []).filter((t) => t.realized_r !== null);
  const s = summarize(closed.map((t) => Number(t.realized_r)));
  let cum = 0;
  const curve = [0, ...closed.map((t) => (cum += Number(t.realized_r)))];

  return (
    <div>
      <PageHead title={`Hi, ${me.name.split(" ")[0]}`} />
      <ErrorNote error={accounts.error || payouts.error} />
      {me.investorId === null && <div className="mb-4 rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">Your login isn’t linked to an investor profile yet.</div>}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi label="Equity" value={money(equity)} foot={`${acc.length} accounts`} />
        <Kpi label="P&L" value={money(pnl)} tone={signed(pnl)} />
        <Kpi label="Paid to you" value={money(received)} tone="text-up" />
        <Kpi label="Pending" value={money(pending)} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Card title="Performance · R" right={<span className="num text-xs text-mute">{s.n} trades · {pct(s.winRate, 0)} win · {r(s.netR)}</span>}>
          <Spark values={curve} height={150} />
        </Card>
        <Card title="Accounts" right={<Link href="/me/accounts" className="text-xs text-mute hover:text-ink">All</Link>}>
          {acc.length === 0 ? <Empty>No accounts yet</Empty> : <div className="space-y-3">{acc.slice(0, 2).map((a) => <AccountProgress key={a.id} a={a} />)}</div>}
        </Card>
      </div>

      <Card title="Payouts" className="mt-4">
        {pays.length === 0 ? <Empty>No payouts yet</Empty> : (
          <Table head={["Period", "Gross", "A+ fee", "To you", "Status"]}>
            {pays.map((p) => (
              <tr key={p.id}>
                <td className="num">{p.period}</td>
                <td className="num">{money(Number(p.gross))}</td>
                <td className="num text-mute">{money(Number(p.commission))}</td>
                <td className="num text-up">{money(Number(p.to_investor))}</td>
                <td><Badge tone={TONE[p.status]}>{p.status}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
