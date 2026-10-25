"use client";

import { useState } from "react";
import { breakevenWinRate, summarize } from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import type { Trade, TradingAccount } from "@/lib/types";
import { num, pct, r, signed } from "@/lib/fmt";
import { Bars, Card, Empty, ErrorNote, Kpi, PageHead, Row, Segmented, Spark, Table } from "@/components/ui";

type Key = "instrument" | "model" | "session_window" | "side";

export default function Analytics() {
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", ascending: true, limit: 5000 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,type" });
  const [scope, setScope] = useState<"master" | "all">("master");
  const masterIds = new Set((accounts.rows ?? []).filter((a) => a.type === "master").map((a) => a.id));
  const closed = (trades.rows ?? []).filter((t) => t.realized_r !== null && (scope === "all" || masterIds.has(t.account_id)));
  const results = closed.map((t) => Number(t.realized_r));
  const s = summarize(results);
  let cum = 0;
  const curve = [0, ...results.map((x) => (cum += x))];
  const avgPlanned = closed.filter((t) => t.planned_r !== null).reduce((a, t, _, arr) => a + Number(t.planned_r) / arr.length, 0);

  const group = (k: Key) => {
    const m = new Map<string, number[]>();
    for (const t of closed) {
      const key = String(t[k] ?? "—");
      m.set(key, [...(m.get(key) ?? []), Number(t.realized_r)]);
    }
    return Array.from(m, ([key, rs]) => ({ key, ...summarize(rs) })).sort((a, b) => b.netR - a.netR);
  };

  const breaks = new Map<string, number>();
  for (const t of closed) for (const b of t.rule_breaks) breaks.set(b, (breaks.get(b) ?? 0) + 1);
  const clean = closed.filter((t) => t.rule_breaks.length === 0).map((t) => Number(t.realized_r));
  const dirty = closed.filter((t) => t.rule_breaks.length > 0).map((t) => Number(t.realized_r));
  const moodBuckets = [["1–4", 1, 4], ["5–7", 5, 7], ["8–10", 8, 10]] as const;

  return (
    <div>
      <PageHead title="Analytics" right={<Segmented value={scope} onChange={setScope} options={[{ v: "master", l: "Master" }, { v: "all", l: "All accounts" }]} />} />
      <ErrorNote error={trades.error} />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi label="Net R" value={r(s.netR)} tone={signed(s.netR)} foot={`${s.n} trades`} />
        <Kpi label="Win rate" value={pct(s.winRate, 1)} foot={avgPlanned ? `break-even ${pct(breakevenWinRate(avgPlanned), 1)} at ${num(avgPlanned, 2)}R` : undefined} />
        <Kpi label="Expectancy" value={r(s.avgR, 3)} tone={signed(s.avgR)} foot="per trade" />
        <Kpi label="Profit factor" value={s.profitFactor === null ? "—" : num(s.profitFactor, 2)} foot={`max DD ${num(s.maxDrawdownR, 2)}R`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Card title="Equity · R"><Spark values={curve} height={160} /></Card>
        <Card title="Profile">
          <div className="divide-y divide-line">
            <Row k="Avg win" v={r(s.avgWin)} tone="text-up" />
            <Row k="Avg loss" v={r(s.avgLoss)} tone="text-down" />
            <Row k="Avg planned" v={avgPlanned ? `${num(avgPlanned, 2)}R` : "—"} />
            <Row k="Recovery factor" v={s.recoveryFactor === null ? "—" : num(s.recoveryFactor, 2)} />
            <Row k="Sharpe / trade" v={s.sharpePerTrade === null ? "—" : num(s.sharpePerTrade, 2)} />
            <Row k="Longest losing streak" v={s.longestLosingStreak} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {(["instrument", "model", "session_window", "side"] as Key[]).map((k) => (
          <Card key={k} title={k === "session_window" ? "Session" : k[0]!.toUpperCase() + k.slice(1)}>
            {closed.length === 0 ? <Empty>No closed trades</Empty> : (
              <Table head={["", "Trades", "Win", "Avg", "Net"]}>
                {group(k).map((g) => (
                  <tr key={g.key}>
                    <td>{g.key.replace("_", " ")}</td>
                    <td className="num">{g.n}</td>
                    <td className="num">{pct(g.winRate, 0)}</td>
                    <td className={`num ${signed(g.avgR)}`}>{r(g.avgR)}</td>
                    <td className={`num ${signed(g.netR)}`}>{r(g.netR)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Discipline">
          <div className="mb-4 grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-raised p-4"><div className="label">Clean</div><div className={`num mt-1 text-xl font-semibold ${signed(summarize(clean).avgR)}`}>{r(summarize(clean).avgR)}</div><div className="text-xs text-mute">{clean.length} trades</div></div>
            <div className="rounded-2xl bg-raised p-4"><div className="label">Rule break</div><div className={`num mt-1 text-xl font-semibold ${signed(summarize(dirty).avgR)}`}>{r(summarize(dirty).avgR)}</div><div className="text-xs text-mute">{dirty.length} trades</div></div>
          </div>
          {breaks.size === 0 ? <Empty>No rule breaks logged</Empty> : <Bars tone="bg-down" items={Array.from(breaks, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value)} />}
        </Card>
        <Card title="Mood">
          <Table head={["Mood", "Trades", "Win", "Avg"]}>
            {moodBuckets.map(([label, lo, hi]) => {
              const rs = closed.filter((t) => t.mood !== null && t.mood >= lo && t.mood <= hi).map((t) => Number(t.realized_r));
              const g = summarize(rs);
              return (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="num">{g.n}</td>
                  <td className="num">{g.n ? pct(g.winRate, 0) : "—"}</td>
                  <td className={`num ${signed(g.avgR)}`}>{g.n ? r(g.avgR) : "—"}</td>
                </tr>
              );
            })}
          </Table>
        </Card>
      </div>
    </div>
  );
}
