"use client";

import Link from "next/link";
import { summarize } from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import type { Investor, Payout, TgMember, Trade, TradingAccount } from "@/lib/types";
import { money, r, pct, signed, dateShort } from "@/lib/fmt";
import { Badge, Card, Empty, ErrorNote, Kpi, PageHead, Spark, Table } from "@/components/ui";
import Sessions from "@/components/Sessions";

export default function Command() {
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 2000 });
  const investors = useRows<Investor>({ table: "investors" });
  const payouts = useRows<Payout>({ table: "payouts", eq: ["status", "pending"] });
  const tg = useRows<TgMember>({ table: "tg_members", select: "id,status" });

  const acc = accounts.rows ?? [];
  const closed = (trades.rows ?? []).filter((t) => t.realized_r !== null).slice().reverse();
  const stats = summarize(closed.map((t) => Number(t.realized_r)));
  let cum = 0;
  const curve = [0, ...closed.map((t) => (cum += Number(t.realized_r)))];
  const live = acc.filter((a) => a.active);
  const aum = live.filter((a) => a.type === "investor").reduce((s, a) => s + Number(a.equity), 0);
  const paid = (tg.rows ?? []).filter((m) => m.status === "active" || m.status === "expiring").length;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const todays = (trades.rows ?? []).filter((t) => new Date(t.opened_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === today);
  const losses = todays.filter((t) => Number(t.realized_r) < 0).length;
  const capHit = todays.length >= 2 || losses >= 2;

  return (
    <div>
      <PageHead title="Command" right={<Link href="/copilot" className="btn-accent">Open copilot</Link>} />
      <ErrorNote error={accounts.error || trades.error || investors.error} />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi label="Net R" value={r(stats.netR)} tone={signed(stats.netR)} foot={`${stats.n} trades · ${pct(stats.winRate, 0)} win`} />
        <Kpi label="Investor equity" value={money(aum)} foot={`${live.filter((a) => a.type === "investor").length} investor accounts`} />
        <Kpi label="Investors" value={investors.rows?.length ?? "—"} foot={`${payouts.rows?.length ?? 0} payouts pending`} />
        <Kpi label="VIP members" value={paid} foot={`${tg.rows?.length ?? 0} tracked`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Sessions />
        <Card title="Today" right={capHit ? <Badge tone="down">Stopped</Badge> : <Badge tone="up">Open</Badge>}>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-2xl bg-raised p-3"><div className="num text-2xl font-semibold">{todays.length}/2</div><div className="label mt-1">A+ trades</div></div>
            <div className="rounded-2xl bg-raised p-3"><div className={`num text-2xl font-semibold ${losses ? "text-down" : ""}`}>{losses}/2</div><div className="label mt-1">Losses</div></div>
            <div className="rounded-2xl bg-raised p-3"><div className={`num text-2xl font-semibold ${signed(todays.reduce((s, t) => s + Number(t.realized_r ?? 0), 0))}`}>{r(todays.reduce((s, t) => s + Number(t.realized_r ?? 0), 0), 1)}</div><div className="label mt-1">Day</div></div>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card title="Equity · R">
          <Spark values={curve} />
        </Card>
        <Card title="Accounts" right={<Link href="/accounts" className="text-xs text-mute hover:text-ink">All</Link>}>
          {acc.length === 0 ? <Empty><Link href="/accounts" className="btn-ghost">Add account</Link></Empty> : (
            <div className="space-y-2">
              {acc.slice(0, 6).map((a) => {
                const pnl = Number(a.equity) - Number(a.start_balance);
                return (
                  <div key={a.id} className="flex items-center justify-between rounded-xl bg-raised px-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{a.name}</div>
                      <div className="text-xs text-mute">{a.venue} · {a.type}</div>
                    </div>
                    <div className="text-right">
                      <div className="num">{money(Number(a.equity), a.currency)}</div>
                      <div className={`num text-xs ${signed(pnl)}`}>{money(pnl, a.currency)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <Card title="Recent trades" className="mt-4" right={<Link href="/trades" className="text-xs text-mute hover:text-ink">Journal</Link>}>
        {(trades.rows ?? []).length === 0 ? <Empty>No trades yet</Empty> : (
          <Table head={["Date", "Instrument", "Side", "Model", "Planned", "Result"]}>
            {(trades.rows ?? []).slice(0, 8).map((t) => (
              <tr key={t.id}>
                <td className="num text-mute">{dateShort(t.opened_at)}</td>
                <td>{t.instrument}</td>
                <td><Badge tone={t.side === "long" ? "up" : "down"}>{t.side}</Badge></td>
                <td>{t.model ?? "—"}</td>
                <td className="num">{r(t.planned_r)}</td>
                <td className={`num ${signed(Number(t.realized_r ?? 0))}`}>{r(t.realized_r)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
