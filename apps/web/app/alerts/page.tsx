"use client";

import { useMemo, useState } from "react";
import { LIVE_INSTRUMENT_IDS as INSTRUMENT_IDS } from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import { staffPost } from "@/lib/market";
import type { TelegramAlert } from "@/lib/types";
import { Card, Chip, Empty, ErrorNote, Kpi, Note, Seg, Table } from "@/components/ui";

/** Every Telegram message the firm sent — manual or autopilot. Send-only; no subscriptions. */
export default function TelegramAlerts() {
  const alerts = useRows<TelegramAlert>({ table: "telegram_alerts", order: "at", limit: 500 });
  const [source, setSource] = useState<"all" | "autopilot" | "manual">("all");
  const [inst, setInst] = useState("all");
  const [status, setStatus] = useState<"all" | "sent" | "failed">("all");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const rows = useMemo(() => (alerts.rows ?? []).filter((a) => (source === "all" || a.source === source) && (inst === "all" || a.instrument === inst) && (status === "all" || a.status === status)), [alerts.rows, source, inst, status]);
  const all = alerts.rows ?? [];
  const today = all.filter((a) => Date.now() - +new Date(a.at) < 86_400_000);
  const failed = all.filter((a) => a.status === "failed").length;

  const send = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await staffPost<{ results: { chat: string; ok: boolean }[] }>("/api/telegram", { text, kind: "manual" });
      setMsg({ ok: true, t: `Sent to ${r.results.filter((x) => x.ok).map((x) => x.chat).join(", ") || "no chat"}` });
      setText("");
    } catch (e) { setMsg({ ok: false, t: (e as Error).message }); }
    alerts.reload();
    setBusy(false);
  };

  return (
    <>
      <ErrorNote error={alerts.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="g12">
        <Kpi label="Sent · last 24 h" value={today.filter((a) => a.status === "sent").length} />
        <Kpi label="Autopilot alerts · 24 h" value={today.filter((a) => a.source === "autopilot").length} />
        <Kpi label="Total logged" value={all.length} foot={<span className="faint">latest 500 shown</span>} />
        <Kpi label="Failed" value={failed} tone={failed ? "down" : ""} foot={<span className="faint">check bot token / chat ids in Settings</span>} />
      </section>
      <section className="g12">
        <Card span={8} title="Alert log" right={<>
          <Seg label="Source" value={source} onChange={setSource} options={[{ v: "all", l: "All" }, { v: "autopilot", l: "Autopilot" }, { v: "manual", l: "Manual" }]} />
          <Seg label="Status" value={status} onChange={setStatus} options={[{ v: "all", l: "All" }, { v: "sent", l: "Sent" }, { v: "failed", l: "Failed" }]} />
          <div className="inp" style={{ width: 140, height: 30 }}><select aria-label="Instrument" value={inst} onChange={(e) => setInst(e.target.value)}><option value="all">All pairs</option>{INSTRUMENT_IDS.map((i) => <option key={i} value={i}>{i}</option>)}</select></div>
        </>}>
          {rows.length === 0 ? <Empty>No alerts match</Empty> : (
            <Table head={["Time (IST)", "Kind", "Pair", "Chat", "Message", "Status"]}>
              {rows.map((a) => (
                <tr key={a.id} onClick={() => setOpen(open === a.id ? null : a.id)} style={{ cursor: "pointer" }}>
                  <td className="mono faint">{new Date(a.at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                  <td><Chip tone={a.kind === "ARMED" ? "up" : a.kind === "CLOSED" ? "info" : ""}>{a.kind}</Chip> <span className="faint" style={{ fontSize: 11 }}>{a.source}</span></td>
                  <td>{a.instrument ?? "—"}</td>
                  <td>{a.chat_label ?? a.chat_id}</td>
                  <td className="wrap" style={{ fontSize: 12, maxWidth: 380, whiteSpace: open === a.id ? "pre-wrap" : "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.text.replace(/<[^>]+>/g, "")}</td>
                  <td>{a.status === "sent" ? <Chip tone="up">sent</Chip> : <Chip tone="down">{a.error ? a.error.slice(0, 30) : "failed"}</Chip>}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card span={4} title="Send an alert">
          <textarea className="inp" style={{ minHeight: 140 }} placeholder={"🟢 <b>XAUUSD</b> long limit 4,120.60 · SL 4,105.60 · TP 4,171.40"} value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
          <p className="faint" style={{ fontSize: 11.5, margin: "6px 0 10px" }}>Telegram HTML: &lt;b&gt;, &lt;i&gt;, &lt;code&gt;. Goes to every chat in Settings and is logged here.</p>
          <button className="btn pri block" disabled={!text.trim() || busy} onClick={send}>{busy ? "Sending…" : "Send"}</button>
        </Card>
      </section>
    </>
  );
}
