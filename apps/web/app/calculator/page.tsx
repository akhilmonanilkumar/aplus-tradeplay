"use client";

import { useMemo, useState } from "react";
import { BTCUSDT_PERP_DEFAULT, MCX_MULTIPLIER, XAUUSD_DEFAULT, breakevenWinRate, rewardToRisk, sizeCfd, sizeMcx, sizePerp } from "@aplus/engine";
import { money, num, pct, toNum } from "@/lib/fmt";
import { Badge, Card, Field, PageHead, Row, Segmented } from "@/components/ui";

type Inst = "XAU" | "BTC" | "MCX";

const DEFAULTS: Record<Inst, Record<string, string>> = {
  XAU: { balance: "10000", risk: "0.5", entry: "2650.00", stop: "2635.00", target: "2700.00", commission: "0" },
  BTC: { balance: "10000", risk: "0.5", entry: "68000", stop: "67500", target: "69500", leverage: "10" },
  MCX: { balance: "500000", risk: "1", entry: "76500", stop: "76350", target: "77000", contract: "GOLDM", charges: "200" },
};

function useCalc(inst: Inst, v: Record<string, string>) {
  return useMemo(() => {
    try {
      const balance = toNum(v.balance), risk = toNum(v.risk), entry = toNum(v.entry), stop = toNum(v.stop), target = toNum(v.target);
      const rr = Number.isFinite(target) && target > 0 ? rewardToRisk(entry, stop, target) : null;
      if (inst === "XAU") {
        const s = sizeCfd({ balance, riskPct: risk, entry, stop, spec: { ...XAUUSD_DEFAULT, commissionPerLot: toNum(v.commission) || 0 } });
        return { ok: true as const, inst, rr, s };
      }
      if (inst === "BTC") {
        const s = sizePerp({ balance, riskPct: risk, entry, stop, target, leverage: toNum(v.leverage), spec: BTCUSDT_PERP_DEFAULT });
        return { ok: true as const, inst, rr, s };
      }
      const mult = MCX_MULTIPLIER[v.contract as keyof typeof MCX_MULTIPLIER] ?? 10;
      const s = sizeMcx({ capital: balance, riskPct: risk, entry, stop, multiplier: mult, chargesPerLot: toNum(v.charges) || 0 });
      return { ok: true as const, inst, rr, s, mult };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [inst, v]);
}

export default function Calculator() {
  const [inst, setInst] = useState<Inst>("XAU");
  const [vals, setVals] = useState(DEFAULTS);
  const v = vals[inst];
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setVals((p) => ({ ...p, [inst]: { ...p[inst], [k]: e.target.value } }));
  const out = useCalc(inst, v);
  const ccy = inst === "MCX" ? "INR" : "USD";
  const meetsRR = out.ok && out.rr !== null && (inst === "BTC" && out.ok && "netRAtTarget" in out.s ? (out.s.netRAtTarget ?? 0) >= 3 : out.rr >= 3);

  return (
    <div>
      <PageHead title="Position size" right={<Segmented value={inst} onChange={setInst} options={[{ v: "XAU", l: "XAUUSD" }, { v: "BTC", l: "BTCUSDT.P" }, { v: "MCX", l: "MCX Gold" }]} />} />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
        <Card title="Inputs">
          <div className="grid grid-cols-2 gap-3">
            <Field label={inst === "MCX" ? "Capital ₹" : "Balance $"}><input className="input num" inputMode="decimal" value={v.balance} onChange={set("balance")} /></Field>
            <Field label="Risk %"><input className="input num" inputMode="decimal" value={v.risk} onChange={set("risk")} /></Field>
            <Field label="Entry"><input className="input num" inputMode="decimal" value={v.entry} onChange={set("entry")} /></Field>
            <Field label="Stop"><input className="input num" inputMode="decimal" value={v.stop} onChange={set("stop")} /></Field>
            <Field label="Target"><input className="input num" inputMode="decimal" value={v.target} onChange={set("target")} /></Field>
            {inst === "XAU" && <Field label="Commission / lot $"><input className="input num" inputMode="decimal" value={v.commission} onChange={set("commission")} /></Field>}
            {inst === "BTC" && <Field label="Leverage ×"><input className="input num" inputMode="decimal" value={v.leverage} onChange={set("leverage")} /></Field>}
            {inst === "MCX" && (
              <>
                <Field label="Contract">
                  <select className="input" value={v.contract} onChange={set("contract")}>
                    <option value="GOLD">GOLD · 1 kg (×100)</option>
                    <option value="GOLDM">GOLDM · 100 g (×10)</option>
                  </select>
                </Field>
                <Field label="Charges / lot ₹"><input className="input num" inputMode="decimal" value={v.charges} onChange={set("charges")} /></Field>
              </>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-mute">
            {inst === "XAU" && <><span className="chip">tick 0.01 = $1 / lot</span><span className="chip">step 0.01</span></>}
            {inst === "BTC" && <><span className="chip">mark price</span><span className="chip">taker 0.05%</span><span className="chip">MMR 0.4%</span><span className="chip">min stop 0.4%</span></>}
            {inst === "MCX" && <span className="chip">₹ per ₹1 move = multiplier</span>}
          </div>
        </Card>

        <Card title="Result" right={out.ok && out.rr !== null ? <Badge tone={meetsRR ? "up" : "down"}>{meetsRR ? "≥ 3R" : "< 3R"}</Badge> : null}>
          {!out.ok ? <p className="text-sm text-down">{out.error}</p> : (
            <>
              <div className="rounded-2xl bg-raised p-5">
                <div className="label">{out.inst === "XAU" ? "Lots" : out.inst === "BTC" ? "Quantity BTC" : "Lots"}</div>
                <div className="num mt-2 text-[44px] font-semibold leading-none text-accent">
                  {out.inst === "XAU" ? num(out.s.lots, 2) : out.inst === "BTC" ? num((out.s as { qty: number }).qty, 3) : (out.s as { lots: number }).lots}
                </div>
                {out.s.belowMinimum && <div className="mt-2 text-sm text-down">Below minimum size — skip or widen risk</div>}
              </div>
              <div className="mt-4 divide-y divide-line">
                <Row k="Risk budget" v={money(out.s.riskBudget, ccy)} />
                {out.inst === "BTC" ? (() => {
                  const s = out.s as ReturnType<typeof sizePerp>;
                  return (
                    <>
                      <Row k="Loss at stop (incl. fees)" v={money(s.lossAtStop, ccy)} tone="text-down" />
                      <Row k="Notional · margin" v={`${money(s.notional, ccy, 0)} · ${money(s.margin, ccy)}`} />
                      <Row k="Fees to stop" v={`${money(s.feesToStop, ccy)} · ${num(s.feeR, 3)}R`} />
                      <Row k="Stop distance" v={`${num(s.stopPct, 3)}%`} tone={s.stopPct < 0.4 ? "text-down" : ""} />
                      <Row k="Liquidation" v={num(s.liquidationPrice, 1)} tone={s.liquidationBeyondStop ? "" : "text-down"} />
                      <Row k="Gross R : R" v={out.rr !== null ? `${num(out.rr, 2)}R` : "—"} />
                      <Row k="Net R at target" v={s.netRAtTarget !== null ? `${num(s.netRAtTarget, 3)}R` : "—"} tone={(s.netRAtTarget ?? 0) >= 3 ? "text-up" : "text-down"} />
                    </>
                  );
                })() : (
                  <>
                    <Row k="Loss per lot" v={money(out.s.lossPerLot, ccy)} />
                    <Row k="Loss at stop" v={money(out.s.riskAmount, ccy)} tone="text-down" />
                    <Row k="Raw size" v={num(out.s.rawLots, 4)} />
                    <Row k="R : R" v={out.rr !== null ? `${num(out.rr, 2)}R` : "—"} tone={meetsRR ? "text-up" : "text-down"} />
                    {out.rr !== null && (() => {
                      const move = Math.abs(toNum(v.target) - toNum(v.entry));
                      const lots = (out.s as { lots: number }).lots;
                      const profit = out.inst === "XAU"
                        ? lots * ((move / XAUUSD_DEFAULT.tickSize) * XAUUSD_DEFAULT.tickValue - (toNum(v.commission) || 0))
                        : lots * (move * (out.mult ?? 10) - (toNum(v.charges) || 0));
                      return <Row k="Profit at target (net)" v={money(profit, ccy)} tone="text-up" />;
                    })()}
                  </>
                )}
                {out.rr !== null && <Row k="Break-even win rate" v={pct(breakevenWinRate(out.rr), 1)} />}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
