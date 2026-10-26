"use client";

import { useState } from "react";
import { staffPost } from "@/lib/market";
import { timeShort } from "@/lib/fmt";
import { Card, Chip, Empty } from "@/components/ui";

/** AI desk analyst (OpenRouter): pre-session brief and Q&A over the engine's JSON. Never decides GO. */
export default function Analyst({ desk, context, notes }: { desk: "gold" | "btc"; context: unknown; notes: { t: number; title: string; body: string }[] }) {
  const [items, setItems] = useState<{ at: number; q: string; a: string; model?: string }[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (task: "brief" | "ask", question = "") => {
    setBusy(true);
    try {
      const r = await staffPost<{ answer: string; model: string }>("/api/ai", { task, desk, question, context });
      setItems((x) => [{ at: Date.now(), q: task === "brief" ? "Pre-session brief" : question, a: r.answer, model: r.model }, ...x].slice(0, 8));
    } catch (e) {
      setItems((x) => [{ at: Date.now(), q: task === "brief" ? "Pre-session brief" : question, a: (e as Error).message }, ...x]);
    }
    setBusy(false);
  };
  return (
    <Card title="Desk analyst" right={<><Chip tone="acc" dot>AI · explains, never decides</Chip><button className="btn sm" disabled={busy} onClick={() => run("brief")}>{busy ? "Thinking…" : "Brief me"}</button></>}>
      {items.length === 0 && notes.length === 0 ? <Empty>Waiting for market data</Empty> : (
        <div className="feed" style={{ maxHeight: 360, overflowY: "auto" }}>
          {items.map((x) => (
            <div key={x.at} className="fi"><span className="t">{timeShort(x.at, "Asia/Kolkata")}</span><div style={{ fontSize: 12.5 }}><b>{x.q}</b><div className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>{x.a}</div>{x.model && <span className="faint" style={{ fontSize: 10.5 }}>{x.model}</span>}</div></div>
          ))}
          {notes.map((n, i) => (
            <div key={`n${i}`} className="fi"><span className="t">{timeShort(n.t, "Asia/Kolkata")}</span><div style={{ fontSize: 12.5 }}><b>{n.title}</b> <span className="muted">{n.body}</span></div></div>
          ))}
        </div>
      )}
      <form className="row" style={{ marginTop: 10 }} onSubmit={(e) => { e.preventDefault(); const v = q.trim(); if (v) { setQ(""); run("ask", v); } }}>
        <div className="inp txt" style={{ flex: 1 }}><input aria-label="Ask the analyst" placeholder="Why no trade? What invalidates this? How is OI behaving?" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className="btn sm" disabled={!q.trim() || busy}>Ask</button>
      </form>
    </Card>
  );
}
