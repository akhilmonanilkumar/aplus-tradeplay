"use client";

import type { Trade, TradingAccount } from "@/lib/types";
import { money, num } from "@/lib/fmt";
import { Chip, Empty, Table } from "@/components/ui";

export default function TradeLog({ trades, accounts, title = "Trade log", limit = 200 }: { trades: Trade[]; accounts: TradingAccount[]; title?: string; limit?: number }) {
  const acc = (id: string) => accounts.find((a) => a.id === id);
  const csv = () => {
    const rows = [["date", "account", "instrument", "side", "entry", "exit", "result_r", "pnl"], ...trades.map((t) => [t.opened_at, acc(t.account_id)?.name ?? "", t.instrument, t.side, t.entry, t.exit ?? "", t.realized_r ?? "", t.pnl ?? ""])];
    const url = URL.createObjectURL(new Blob([rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "trades.csv"; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <section className="card flush" id="log">
      <div className="ch" style={{ padding: "14px 16px 0" }}><h3>{title}</h3><span className="sp" /><button className="btn sm" onClick={csv} disabled={!trades.length}>Download CSV</button></div>
      {trades.length === 0 ? <div style={{ padding: 16 }}><Empty>No trades yet</Empty></div> : (
        <Table head={["Date", "Account", "Instrument", "Side", "Entry", "Exit", "Result", "P&L"]} right={[4, 5, 6, 7]}>
          {trades.slice(0, limit).map((t) => {
            const a = acc(t.account_id);
            return (
              <tr key={t.id}>
                <td className="mono faint">{new Date(t.opened_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</td>
                <td>{a?.name ?? "—"}</td><td>{t.instrument}</td>
                <td><Chip tone={t.side === "long" ? "up" : "down"}>{t.side === "long" ? "Long" : "Short"}</Chip></td>
                <td className="r mono">{num(Number(t.entry), 2)}</td>
                <td className="r mono">{t.exit !== null ? num(Number(t.exit), 2) : <span className="faint">open</span>}</td>
                <td className="r">{t.realized_r === null ? <Chip tone="info">Open</Chip> : <span className={`mono ${Number(t.realized_r) >= 0 ? "up" : "down"}`}>{Number(t.realized_r) > 0 ? "+" : ""}{num(Number(t.realized_r), 2)}R</span>}</td>
                <td className={`r mono ${Number(t.pnl ?? 0) >= 0 ? "up" : "down"}`}>{t.pnl !== null ? `${Number(t.pnl) > 0 ? "+" : ""}${money(Number(t.pnl), a?.currency ?? "USD")}` : "—"}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </section>
  );
}
