"use client";

import { useRows } from "@/lib/useRows";
import type { Trade, TradingAccount } from "@/lib/types";
import { dateShort, money, num, r, signed } from "@/lib/fmt";
import { Badge, Card, Empty, ErrorNote, PageHead, Table } from "@/components/ui";

export default function InvestorTrades() {
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 1000 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,currency" });
  const acc = (id: string) => (accounts.rows ?? []).find((a) => a.id === id);
  const rows = trades.rows ?? [];
  return (
    <div>
      <PageHead title="Trades" />
      <ErrorNote error={trades.error} />
      <Card>
        {rows.length === 0 ? <Empty>No trades yet</Empty> : (
          <Table head={["Date", "Account", "Instrument", "Side", "Entry", "Exit", "Result", "P&L"]}>
            {rows.map((t) => {
              const a = acc(t.account_id);
              return (
                <tr key={t.id}>
                  <td className="num text-mute">{dateShort(t.opened_at)}</td>
                  <td className="max-w-[160px] truncate">{a?.name ?? "—"}</td>
                  <td>{t.instrument}</td>
                  <td><Badge tone={t.side === "long" ? "up" : "down"}>{t.side}</Badge></td>
                  <td className="num">{num(Number(t.entry), 2)}</td>
                  <td className="num">{t.exit !== null ? num(Number(t.exit), 2) : <Badge tone="accent">open</Badge>}</td>
                  <td className={`num ${signed(Number(t.realized_r ?? 0))}`}>{r(t.realized_r)}</td>
                  <td className={`num ${signed(Number(t.pnl ?? 0))}`}>{t.pnl !== null ? money(Number(t.pnl), a?.currency ?? "USD") : "—"}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </div>
  );
}
