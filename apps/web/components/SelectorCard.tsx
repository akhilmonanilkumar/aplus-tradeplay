"use client";

import { useState } from "react";
import { INSTRUMENTS, type InstrumentId } from "@aplus/engine";
import { DEFAULT_SELECTOR_CONFIG, selectorConfig, type SelectorConfig } from "@/lib/selectorConfig";
import { ownerOf } from "@/lib/accounts";
import type { AutopilotRun, Investor, TradingAccount } from "@/lib/types";
import { num } from "@/lib/fmt";
import { staffPost } from "@/lib/market";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, Note, Table, Toggle } from "@/components/ui";

interface BoardRow { instrument: InstrumentId; side: string; state: string; score: number; eligible: boolean; reasons: string[] }
interface Board { ranked?: BoardRow[]; picks?: { instrument: string; side: string; score: number; why: string[]; plan: { entry: number; stop: number; target: number; rr: number | null }; action: string }[]; edges?: Record<string, { avgR: number; n: number; winRate: number; at: string }>; busy?: string[] }

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export default function SelectorCard({ runs, accounts, investors }: { runs: AutopilotRun[]; accounts: TradingAccount[]; investors: Investor[] }) {
  const me = useMe();
  const cfg = selectorConfig(me.settings?.integrations?.selector ?? DEFAULT_SELECTOR_CONFIG);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ at: number; board: Board; picks: { instrument: string; side: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (patch: Partial<SelectorConfig>) => {
    const integ = me.settings?.integrations ?? { telegram_chats: [], ai_model: null };
    const e = await me.updateSettings({ integrations: { ...integ, selector: { ...cfg, ...patch } } });
    setMsg(e);
  };
  const numField = (label: string, key: "minScore" | "maxPerDay" | "cooldownMin" | "riskPct", unit: string, lo: number, hi: number) => (
    <label className="fld"><span>{label}</span><div className="inp"><input inputMode="decimal" key={`${key}:${cfg[key]}`} defaultValue={cfg[key]} onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= lo && v <= hi && v !== cfg[key]) save({ [key]: v }); }} /><span className="u">{unit}</span></div></label>
  );

  const runPreview = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await staffPost<{ at: number; preview: { picks: { instrument: string; side: string }[]; ranked: BoardRow[]; edges?: Board["edges"]; busy?: string[] } }>("/api/autopilot/tick?preview=selector", {});
      setPreview({ at: r.at, picks: r.preview.picks, board: { ranked: r.preview.ranked, edges: r.preview.edges, busy: r.preview.busy } });
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  };

  const sel = runs.filter((r) => r.instrument === "SELECTOR");
  const board = preview?.board ?? ((sel.find((r) => r.state !== "ERROR")?.detail ?? null) as Board | null);
  const picks = sel.filter((r) => r.state === "PICK").slice(0, 5);
  const err = sel[0]?.state === "ERROR" ? (sel[0].detail as { error?: string }).error : null;
  const pickNow = new Set((preview?.picks ?? board?.picks ?? []).map((p) => `${p.instrument}:${p.side}`));
  const acc = accounts.filter((a) => a.active && a.currency !== "INR");

  return (
    <Card title="Best-opportunity selector" right={<div className="row" style={{ gap: 8 }}><Chip tone={cfg.enabled ? "up" : ""}>{cfg.enabled ? "On" : "Off"}</Chip><Toggle on={cfg.enabled} onChange={(v) => save({ enabled: v })} label="Selector on" /></div>}>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Every pass it reads every instrument below, keeps only setups the A+ gate passes, and scores them 0–100: gate quality 40, R:R 15, confluence (dollar, yields, funding, OI, flow, COT) 20, the edge&apos;s last-3-weeks walk-forward result on that instrument 15, timing 10, minus caution flags. The best setup per underlying goes to Telegram as one trade ticket with size per account. Gold and BTC are never doubled, and a desk waits while its last pick is pending, open or cooling down.
      </p>
      {msg && <Note tone="down">{msg}</Note>}
      {err && <Note tone="down">Last pass failed: {err}</Note>}
      {cfg.enabled && <Note tone="info">Per-instrument modes still run on their own. Set them to Off to get only the selector&apos;s picks.</Note>}

      <div className="auto-s" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10, marginTop: 8 }}>
        {numField("Minimum score", "minScore", "/100", 0, 100)}
        {numField("Max picks per day", "maxPerDay", "IST", 0, 20)}
        {numField("Desk cooldown", "cooldownMin", "min", 0, 1440)}
        {numField("Risk per account", "riskPct", "%", 0.01, 2)}
      </div>
      <div className="between" style={{ marginTop: 10 }}><span style={{ fontSize: 12.5 }}>Also pick grade A (one soft miss)</span><Toggle on={cfg.allowGradeA} onChange={(v) => save({ allowGradeA: v })} label="Grade A" /></div>
      <div className="between" style={{ marginTop: 8 }}><span style={{ fontSize: 12.5 }}>Track each pick as paper orders (fills, stop, target and P&amp;L on Telegram)</span><Toggle on={cfg.paper} onChange={(v) => save({ paper: v })} label="Paper tracking" /></div>

      <div className="lbl-u" style={{ margin: "12px 0 6px" }}>Instruments scanned</div>
      <div className="row" style={{ gap: 6 }}>
        {(Object.keys(INSTRUMENTS) as InstrumentId[]).map((i) => {
          const on = cfg.universe.includes(i);
          return <button key={i} type="button" className={`chip ${on ? "acc" : ""}`} onClick={() => save({ universe: on ? cfg.universe.filter((x) => x !== i) : [...cfg.universe, i] })}>{i}</button>;
        })}
      </div>
      <div className="lbl-u" style={{ margin: "12px 0 6px" }}>Accounts sized in the ticket ({cfg.account_ids.length})</div>
      {acc.length === 0 ? <p className="faint" style={{ fontSize: 12 }}>No accounts yet.</p> : (
        <div className="row" style={{ gap: 6 }}>
          {acc.map((a) => {
            const on = cfg.account_ids.includes(a.id);
            return <button key={a.id} type="button" className={`chip ${on ? "acc" : ""}`} onClick={() => save({ account_ids: on ? cfg.account_ids.filter((x) => x !== a.id) : [...cfg.account_ids, a.id] })}>{a.name} · {ownerOf(a, investors).label}</button>;
          })}
        </div>
      )}

      <div className="between" style={{ margin: "16px 0 6px" }}>
        <span className="lbl-u">{preview ? `Preview · ${when(new Date(preview.at).toISOString())} · nothing sent` : `Board${sel[0] ? ` · ${when(sel[0].at)}` : ""}`}{board?.busy?.length ? ` · busy: ${board.busy.join(", ")}` : ""}</span>
        <button className="btn ghost sm" onClick={runPreview} disabled={busy}>{busy ? "Scoring…" : "Preview board"}</button>
      </div>
      {!board?.ranked?.length ? <Empty>{cfg.enabled ? "Waiting for the next pass" : "Preview the board, or turn the selector on"}</Empty> : (
        <Table head={["Instrument", "Side", "State", "Score", "Edge (3w)", "Status"]} right={[3]}>
          {board.ranked.map((r) => {
            const e = board.edges?.[r.instrument];
            const picked = pickNow.has(`${r.instrument}:${r.side}`);
            return (
              <tr key={`${r.instrument}:${r.side}`}>
                <td>{r.instrument}</td>
                <td className="faint">{r.side}</td>
                <td><Chip tone={r.state === "ARMED" ? "up" : r.state === "SHIFTED" || r.state === "SWEPT" ? "warn" : ""}>{r.state}</Chip></td>
                <td className="r mono">{r.score}</td>
                <td className="mono faint">{e && e.n ? `${e.avgR >= 0 ? "+" : ""}${num(e.avgR, 2)}R · ${e.n}` : "—"}</td>
                <td className="wrap" style={{ fontSize: 11.5 }}>{picked ? <Chip tone="up">{preview ? "would pick" : "picked"}</Chip> : r.eligible ? <Chip tone="info">eligible</Chip> : <span className="faint">{r.reasons.join(" · ")}</span>}</td>
              </tr>
            );
          })}
        </Table>
      )}

      <div className="lbl-u" style={{ margin: "16px 0 6px" }}>Recent picks</div>
      {picks.length === 0 ? <p className="faint" style={{ fontSize: 12 }}>None yet.</p> : picks.map((r) => (
        <div key={r.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
          <div className="between"><b>{r.action?.split(" · ")[0]}</b><span className="mono faint">{when(r.at)}</span></div>
          {((r.detail as Board).picks ?? []).map((p) => (
            <div key={p.instrument} className="faint" style={{ fontSize: 11.5 }}>
              <span className="mono">{num(p.plan.entry, 2)} / SL {num(p.plan.stop, 2)} / TP {num(p.plan.target, 2)}{p.plan.rr ? ` · ${num(p.plan.rr, 2)}R` : ""}</span> · {p.why.join(" · ")} · {p.action}
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}
