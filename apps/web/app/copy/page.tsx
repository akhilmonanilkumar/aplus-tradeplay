"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BTCUSDT_PERP_DEFAULT, XAUUSD_DEFAULT, clientOrderId, planCopies, type CopyAccount } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { TradingAccount } from "@/lib/types";
import { money, num, r, dateShort } from "@/lib/fmt";
import { Badge, Card, Empty, ErrorNote, Kpi, PageHead, Table } from "@/components/ui";

type Signal = { id: string; instrument: string; side: "long" | "short"; model: string; entry: number; stop: number; target: number; rr: number | null; grade: string; state: string; created_at: string };
type Order = { id: string; signal_id: string | null; account_id: string; action: string; qty: number; risk_amount: number | null; status: string; latency_ms: number | null; created_at: string };

const ACTION_TONE: Record<string, string> = { SEND: "up", CONFIRM: "accent", MANUAL: "chart", PAPER: "mute", BLOCK: "down", SKIP: "mute" };

/** Loss-limit room from the firm rules on the account (falls back to no cap). */
function rooms(a: TradingAccount) {
  const start = Number(a.start_balance) || Number(a.balance);
  const eq = Number(a.equity) || Number(a.balance);
  const rules = a.firm_rules ?? {};
  const out: { dailyLossRoom?: number; maxLossRoom?: number } = {};
  if (rules.daily_loss_pct) out.dailyLossRoom = Math.max(0, (start * rules.daily_loss_pct) / 100 - Math.max(0, Number(a.balance) - eq));
  if (rules.max_loss_pct) out.maxLossRoom = Math.max(0, eq - start * (1 - rules.max_loss_pct / 100));
  return out;
}

function CopyEngine() {
  const params = useSearchParams();
  const signals = useRows<Signal>({ table: "signals", order: "created_at", limit: 30 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const orders = useRows<Order>({ table: "orders", order: "created_at", limit: 50 });
  const [picked, setPicked] = useState<string | null>(params.get("s"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sig = (signals.rows ?? []).find((s) => s.id === picked) ?? (signals.rows ?? [])[0] ?? null;
  const isPerp = sig?.instrument.startsWith("BTC");
  const targets = (accounts.rows ?? []).filter((a) => a.active && a.type !== "master" && a.currency !== "INR");

  const { plan, planError } = useMemo(() => {
    if (!sig) return { plan: [], planError: null };
    const copyAccounts: CopyAccount[] = targets.map((a) => ({
      id: a.id,
      name: a.name,
      policy: a.copy_policy,
      balance: Number(a.balance),
      riskPct: Number(a.risk_pct),
      instrument: isPerp ? { kind: "perp", spec: BTCUSDT_PERP_DEFAULT, leverage: 10 } : { kind: "cfd", spec: XAUUSD_DEFAULT },
      ...rooms(a),
    }));
    try {
      return { plan: planCopies({ entry: Number(sig.entry), stop: Number(sig.stop), target: Number(sig.target) }, copyAccounts), planError: null };
    } catch (e) {
      return { plan: [], planError: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig?.id, accounts.rows]);

  const send = async () => {
    if (!sig) return;
    setBusy(true);
    setError(null);
    const rows = plan.filter((d) => d.action !== "SKIP").map((d) => ({
      signal_id: sig.id,
      account_id: d.accountId,
      client_order_id: clientOrderId(sig.id, d.accountId),
      action: d.action,
      side: sig.side,
      qty: d.size,
      entry: sig.entry,
      stop: sig.stop,
      target: sig.target,
      risk_amount: d.riskAmount,
      reasons: d.reasons,
      status: d.action === "SEND" ? "queued" : d.action === "CONFIRM" ? "awaiting_confirm" : d.action === "MANUAL" ? "manual_pending" : d.action === "BLOCK" ? "blocked" : "queued",
    }));
    const { error } = await supabase.from("orders").upsert(rows, { onConflict: "client_order_id", ignoreDuplicates: true });
    setBusy(false);
    if (error) return setError(error.message);
    orders.reload();
  };

  const name = (id: string) => (accounts.rows ?? []).find((a) => a.id === id)?.name ?? "—";
  const sendable = plan.filter((d) => d.action === "SEND").length;
  const blocked = plan.filter((d) => d.action === "BLOCK").length;
  const totalRisk = plan.reduce((s, d) => s + d.riskAmount, 0);
  const lat = (orders.rows ?? []).map((o) => o.latency_ms).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor(lat.length * 0.5)] : null;

  return (
    <div>
      <PageHead title="Copy engine" right={<button className="btn-accent" onClick={send} disabled={busy || !sig || plan.length === 0}>{busy ? "Queueing…" : "Queue orders"}</button>} />
      <ErrorNote error={error || planError || signals.error || accounts.error} />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi label="Targets" value={targets.length} foot={`${sendable} auto · ${blocked} blocked`} />
        <Kpi label="Total risk" value={money(totalRisk)} />
        <Kpi label="Signal" value={sig ? `${sig.instrument.replace("USDT.P", "")} ${sig.side}` : "—"} foot={sig ? `${r(sig.rr)} · ${sig.grade}` : undefined} />
        <Kpi label="Latency p50" value={p50 !== null ? `${p50} ms` : "—"} foot={`${lat.length} fills`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_2fr]">
        <Card title="Signals">
          {(signals.rows ?? []).length === 0 ? <Empty>No signals</Empty> : (
            <div className="space-y-1.5">
              {(signals.rows ?? []).map((s) => (
                <button key={s.id} onClick={() => setPicked(s.id)} className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition ${sig?.id === s.id ? "bg-raised ring-1 ring-accent/50" : "hover:bg-raised"}`}>
                  <div>
                    <div className="font-medium">{s.instrument} <span className={s.side === "long" ? "text-up" : "text-down"}>{s.side}</span></div>
                    <div className="num text-xs text-mute">{num(Number(s.entry), 2)} / {num(Number(s.stop), 2)} · {dateShort(s.created_at)}</div>
                  </div>
                  <Badge tone={s.grade === "A+" ? "accent" : "mute"}>{s.grade}</Badge>
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card title="Fan-out">
          {!sig ? <Empty>Pick a signal</Empty> : plan.length === 0 ? <Empty>No active copy accounts</Empty> : (
            <Table head={["Account", "Policy", "Size", "Risk", "Action", "Guard"]}>
              {plan.map((d) => {
                const a = targets.find((t) => t.id === d.accountId)!;
                return (
                  <tr key={d.accountId}>
                    <td><div className="font-medium">{a.name}</div><div className="text-xs text-mute">{a.venue}</div></td>
                    <td className="text-mute">{a.copy_policy}</td>
                    <td className="num">{isPerp ? num(d.size, 3) : num(d.size, 2)}</td>
                    <td className="num">{money(d.riskAmount)}</td>
                    <td><Badge tone={ACTION_TONE[d.action]}>{d.action}</Badge></td>
                    <td className="max-w-[220px] text-xs text-mute">{d.reasons.join(" · ") || (d.shrunk ? "shrunk" : "ok")}</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
      </div>

      <Card title="Order log" className="mt-4">
        {(orders.rows ?? []).length === 0 ? <Empty>No orders</Empty> : (
          <Table head={["Time", "Account", "Action", "Qty", "Risk", "Status"]}>
            {(orders.rows ?? []).map((o) => (
              <tr key={o.id}>
                <td className="num text-mute">{new Date(o.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</td>
                <td>{name(o.account_id)}</td>
                <td><Badge tone={ACTION_TONE[o.action]}>{o.action}</Badge></td>
                <td className="num">{num(Number(o.qty), 3)}</td>
                <td className="num">{money(o.risk_amount)}</td>
                <td className="text-mute">{o.status.replace("_", " ")}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

export default function Page() {
  return <Suspense><CopyEngine /></Suspense>;
}
