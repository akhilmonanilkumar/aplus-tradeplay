"use client";

import { useRows } from "@/lib/useRows";
import type { PropPurchase, TradingAccount } from "@/lib/types";
import { dateShort, money } from "@/lib/fmt";
import { Badge, Card, Empty, ErrorNote, PageHead, Table } from "@/components/ui";
import AccountProgress from "@/components/AccountProgress";

export default function InvestorAccounts() {
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const purchases = useRows<PropPurchase>({ table: "prop_purchases", order: "created_at" });
  const acc = accounts.rows ?? [];
  return (
    <div>
      <PageHead title="Accounts" />
      <ErrorNote error={accounts.error} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {acc.length === 0 && <div className="sm:col-span-2 xl:col-span-3"><Empty>No accounts yet</Empty></div>}
        {acc.map((a) => <AccountProgress key={a.id} a={a} />)}
      </div>
      <Card title="Purchases" className="mt-4">
        {(purchases.rows ?? []).length === 0 ? <Empty>None</Empty> : (
          <Table head={["Ref", "Firm", "Size", "Date", "Status"]}>
            {(purchases.rows ?? []).map((p) => (
              <tr key={p.id}>
                <td className="num text-xs">{p.ref}</td>
                <td>{p.firm} <span className="text-mute">· {p.plan}</span></td>
                <td className="num">{money(Number(p.size), "USD", 0)}</td>
                <td className="num text-mute">{dateShort(p.created_at)}</td>
                <td><Badge tone={p.status === "funded" ? "up" : p.status === "breached" ? "down" : p.status === "evaluation" ? "accent" : "mute"}>{p.status.replace("_", " ")}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
