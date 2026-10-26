"use client";

import { Suspense } from "react";
import { hwmFee } from "@aplus/engine";
import { useInvestor } from "@/lib/useInvestor";
import type { Payout, Trade } from "@/lib/types";
import { dateShort, money, num, pct } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Table } from "@/components/ui";
import InvestorPicker from "@/components/InvestorPicker";
import InvestorGrowth from "@/components/InvestorGrowth";

type Wf = { k: string; v: string; p: number; c: string; tot?: boolean };
function Waterfall({ rows }: { rows: Wf[] }) {
  return <>{rows.map((w) => (
    <div key={w.k} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 110px", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: w.tot ? 0 : "1px solid var(--line)", fontSize: 13, fontWeight: w.tot ? 600 : 400 }}>
      <div className="col" style={{ gap: 4 }}><span>{w.k}</span><div style={{ height: 8, borderRadius: 99, width: `${Math.max(1, Math.min(100, w.p))}%`, background: w.c }} /></div>
      <span className="mono" style={{ textAlign: "right" }}>{w.v}</span>
    </div>
  ))}</>;
}

function prop(p: Payout, rate: number): Wf[] {
  const gross = Number(p.gross), split = Number(p.firm_split ?? 1), firmPays = gross * split;
  return [
    { k: "Profit on funded account", v: money(gross), p: 100, c: "var(--faint)" },
    { k: `Firm keeps ${pct(1 - split, 0)}`, v: `−${money(gross - firmPays)}`, p: ((gross - firmPays) / gross) * 100, c: "var(--surface-3)" },
    { k: "Firm pays out", v: money(firmPays), p: (firmPays / gross) * 100, c: "var(--accent)" },
    { k: `A+ commission ${pct(rate, 0)}`, v: `−${money(Number(p.commission))}`, p: (Number(p.commission) / gross) * 100, c: "var(--down)" },
    { k: "Paid to you", v: money(Number(p.to_investor)), p: (Number(p.to_investor) / gross) * 100, c: "var(--up)", tot: true },
  ];
}
function hwm(p: Payout, rate: number): Wf[] {
  const above = Number(p.gross), base = Math.max(above, 1);
  return [
    { k: `High-water mark ${p.hwm_before ? money(Number(p.hwm_before)) : ""}`, v: "", p: 100, c: "var(--surface-3)" },
    { k: "Profit above HWM", v: money(above), p: 100, c: "var(--accent)" },
    { k: `Performance fee ${pct(rate, 0)}`, v: `−${money(Number(p.commission))}`, p: (Number(p.commission) / base) * 100, c: "var(--down)" },
    { k: "Paid to you", v: money(Number(p.to_investor)), p: (Number(p.to_investor) / base) * 100, c: "var(--up)", tot: true },
  ];
}
const status = (p: Payout) => p.status === "paid" ? <Chip tone="up">Paid {dateShort(p.paid_at)}</Chip> : p.status === "approved" ? <Chip tone="acc">Approved</Chip> : p.status === "held" ? <Chip tone="warn">Held</Chip> : <Chip tone="info">Pending</Chip>;

function Overview() {
  const d = useInvestor();
  const inv = d.investor;
  const rate = inv ? Number(inv.fee_rate) : 0.2;
  const paid = d.payouts.filter((p) => p.status === "paid");
  const pendingAmt = d.payouts.filter((p) => p.status === "pending" || p.status === "approved").reduce((s, p) => s + Number(p.to_investor), 0);
  const value = d.accounts.filter((a) => a.currency !== "INR").reduce((s, a) => s + Number(a.equity), 0);
  const managed = d.accounts.filter((a) => a.type === "investor" && a.hwm !== null && !a.firm_rules?.profit_target_pct);
  const accrued = managed.reduce((s, a) => s + hwmFee({ navEnd: Number(a.equity), hwm: Number(a.hwm), rate }).fee, 0);
  const lastHwm = d.payouts.find((p) => p.kind === "hwm");
  const lastProp = d.payouts.find((p) => p.kind === "prop");
  const hist = d.payouts.filter((p) => p.kind === "hwm");
  const recent: Trade[] = d.trades.slice(0, 10);
  const acc = (id: string) => d.accounts.find((a) => a.id === id);

  const statement = () => {
    const lines = [["date", "account", "instrument", "side", "qty", "entry", "exit", "result_r", "pnl"], ...d.trades.map((t) => [t.opened_at, acc(t.account_id)?.name ?? "", t.instrument, t.side, t.qty, t.entry, t.exit ?? "", t.realized_r ?? "", t.pnl ?? ""]), [], ["period", "kind", "gross", "commission", "to_investor", "status"], ...d.payouts.map((p) => [p.period, p.kind, p.gross, p.commission, p.to_investor, p.status])];
    const csv = lines.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `statement-${new Date().toISOString().slice(0, 7)}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  if (d.loading) return <Empty>Loading…</Empty>;
  return (
    <>
      <InvestorPicker investors={d.investors} current={inv?.id ?? null} />
      <ErrorNote error={d.error} />
      {!inv ? <Empty>Your login isn&apos;t linked to an investor profile yet.</Empty> : (
        <>
          <section className="g12">
            <div className="card s3"><div className="lbl">Paid to you · lifetime</div><div className="kv lg up" style={{ marginTop: 6 }}>{money(paid.reduce((s, p) => s + Number(p.to_investor), 0))}</div><div className="faint" style={{ fontSize: 12 }}>after the {pct(rate, 0)} fee · {money(pendingAmt)} pending</div></div>
            <div className="card s3"><div className="lbl">Performance fee paid</div><div className="kv lg" style={{ marginTop: 6 }}>{money(paid.reduce((s, p) => s + Number(p.commission), 0))}</div><div className="faint" style={{ fontSize: 12 }}>only on profit you received</div></div>
            <div className="card s3"><div className="lbl">Current value · {d.accounts.length} account{d.accounts.length === 1 ? "" : "s"}</div><div className="kv lg" style={{ marginTop: 6 }}>{money(value)}</div><div className="faint" style={{ fontSize: 12 }}>open trades included</div></div>
            <div className="card s3"><div className="lbl">Accrued fee if closed today</div><div className="kv lg" style={{ marginTop: 6 }}>{money(accrued)}</div><div className="faint" style={{ fontSize: 12 }}>{managed.length ? `${pct(rate, 0)} × (value − HWM)` : "no managed account"}</div></div>
          </section>

          <InvestorGrowth accounts={d.accounts} />

          <section className="g12">
            <Card span={6} title={lastHwm ? `${lastHwm.period} payout · ${acc(lastHwm.account_id ?? "")?.name ?? "managed"}` : "Managed account payout"} right={lastHwm ? status(lastHwm) : null}>
              {lastHwm ? <Waterfall rows={hwm(lastHwm, rate)} /> : <Empty>No managed-account payout yet</Empty>}
            </Card>
            <Card span={6} title={lastProp ? `Funded account payout · ${acc(lastProp.account_id ?? "")?.name ?? lastProp.period}` : "Funded account payout"} right={lastProp ? status(lastProp) : null}>
              {lastProp ? <Waterfall rows={prop(lastProp, rate)} /> : <Empty>No funded-account payout yet</Empty>}
            </Card>
          </section>

          <section className="g12">
            <div className="card flush s7" id="payouts">
              <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Payout history</h3></div>
              {d.payouts.length === 0 ? <div style={{ padding: 16 }}><Empty>No payouts yet</Empty></div> : (
                <Table head={["Period", "Kind", hist.length ? "HWM" : "Split", "Gross", `Fee ${pct(rate, 0)}`, "Paid to you", "Status"]} right={[2, 3, 4, 5]}>
                  {d.payouts.map((p) => <tr key={p.id}><td>{p.period}</td><td className="muted">{p.kind === "prop" ? "Funded" : "Managed"}</td><td className="r mono">{p.kind === "hwm" ? money(Number(p.hwm_before ?? 0)) : pct(Number(p.firm_split ?? 1), 0)}</td><td className="r mono">{money(Number(p.gross))}</td><td className="r mono">{money(Number(p.commission))}</td><td className="r mono up">{money(Number(p.to_investor))}</td><td>{status(p)}</td></tr>)}
                </Table>
              )}
            </div>
            <Card span={5} id="docs" title="Documents">
              <div className="col" style={{ gap: 10 }}>
                <div className="between"><div className="col" style={{ gap: 1 }}><b style={{ fontSize: 12.5, fontWeight: 500 }}>Allocation agreement &amp; fee terms</b><span className="faint" style={{ fontSize: 11.5 }}>{inv.agreement_signed_at ? `Signed ${dateShort(inv.agreement_signed_at)}` : "Not signed yet"}</span></div><Chip tone={inv.agreement_signed_at ? "up" : "warn"}>{inv.agreement_signed_at ? "On file" : "Pending"}</Chip></div>
                <div className="between"><div className="col" style={{ gap: 1 }}><b style={{ fontSize: 12.5, fontWeight: 500 }}>Risk disclosure</b><span className="faint" style={{ fontSize: 11.5 }}>{inv.risk_disclosure_at ? `Acknowledged ${dateShort(inv.risk_disclosure_at)}` : "Not acknowledged yet"}</span></div><Chip tone={inv.risk_disclosure_at ? "up" : "warn"}>{inv.risk_disclosure_at ? "On file" : "Pending"}</Chip></div>
                <div className="between"><div className="col" style={{ gap: 1 }}><b style={{ fontSize: 12.5, fontWeight: 500 }}>Statement</b><span className="faint" style={{ fontSize: 11.5 }}>CSV · trades, fees, payouts</span></div><button className="btn sm" onClick={statement}>Download</button></div>
                <div className="banner info" style={{ fontSize: 12 }}>Losses are possible, including loss of the whole allocation.</div>
              </div>
            </Card>
          </section>

          <section className="card flush" id="trades">
            <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Open &amp; recent trades on your account</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Read-only</span></div>
            {recent.length === 0 ? <div style={{ padding: 16 }}><Empty>No trades yet</Empty></div> : (
              <Table head={["Time", "Instrument", "Side", "Qty", "Entry", "Stop", "Target", "Result"]} right={[3, 4, 5, 6, 7]}>
                {recent.map((t) => (
                  <tr key={t.id}>
                    <td className="mono faint">{new Date(t.opened_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</td>
                    <td>{t.instrument}</td><td><Chip tone={t.side === "long" ? "up" : "down"}>{t.side === "long" ? "Long" : "Short"}</Chip></td>
                    <td className="r mono">{num(Number(t.qty), 3)}</td><td className="r mono">{num(Number(t.entry), 2)}</td><td className="r mono">{num(Number(t.stop), 2)}</td><td className="r mono">{t.target !== null ? num(Number(t.target), 2) : "—"}</td>
                    <td className="r">{t.realized_r === null ? <Chip tone="info">Open</Chip> : <span className={`mono ${Number(t.realized_r) >= 0 ? "up" : "down"}`}>{Number(t.realized_r) > 0 ? "+" : ""}{num(Number(t.realized_r), 2)}R</span>}</td>
                  </tr>
                ))}
              </Table>
            )}
          </section>
        </>
      )}
    </>
  );
}

export default function Page() { return <Suspense><Overview /></Suspense>; }
