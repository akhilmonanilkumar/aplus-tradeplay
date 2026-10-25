import type { TradingAccount } from "@/lib/types";
import { money, pct, signed } from "@/lib/fmt";
import { Badge } from "@/components/ui";

/** Read-only account card: balance, P&L, target progress and loss-floor room. */
export default function AccountProgress({ a }: { a: TradingAccount }) {
  const start = Number(a.start_balance) || 1;
  const eq = Number(a.equity);
  const pnl = eq - start;
  const rules = a.firm_rules ?? {};
  const target = rules.profit_target_pct ? (start * rules.profit_target_pct) / 100 : null;
  const floor = rules.max_loss_pct ? start * (1 - rules.max_loss_pct / 100) : null;
  const room = floor !== null ? eq - floor : null;
  const roomPct = floor !== null && room !== null ? room / (start - floor) : null;
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{a.name}</div>
          <div className="text-xs text-mute">{a.venue}</div>
        </div>
        <Badge tone={a.active ? "up" : "mute"}>{a.active ? "active" : "paused"}</Badge>
      </div>
      <div className="num mt-4 text-[28px] font-semibold leading-none">{money(eq, a.currency)}</div>
      <div className={`num mt-1 text-sm ${signed(pnl)}`}>{money(pnl, a.currency)} · {pct(pnl / start, 2)}</div>
      {target !== null && (
        <div className="mt-4">
          <div className="flex justify-between text-xs text-mute"><span>Profit target</span><span className="num">{money(Math.max(0, pnl), a.currency, 0)} / {money(target, a.currency, 0)}</span></div>
          <div className="mt-1.5 h-2 rounded-full bg-raised"><div className="h-2 rounded-full bg-up" style={{ width: `${Math.min(100, Math.max(0, pnl / target) * 100)}%` }} /></div>
        </div>
      )}
      {roomPct !== null && room !== null && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-mute"><span>Drawdown room</span><span className="num">{money(room, a.currency, 0)}</span></div>
          <div className="mt-1.5 h-2 rounded-full bg-raised"><div className={`h-2 rounded-full ${roomPct < 0.35 ? "bg-down" : roomPct < 0.6 ? "bg-warn" : "bg-chart"}`} style={{ width: `${Math.min(100, Math.max(0, roomPct) * 100)}%` }} /></div>
        </div>
      )}
    </div>
  );
}
