"use client";

import { useState } from "react";
import { EDGE_WINDOWS, windowOnDateOf, wallToUtc } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { NewsEvent } from "@/lib/types";
import { timeShort } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote, Note, Table, Toggle } from "@/components/ui";

export default function News() {
  const me = useMe();
  const events = useRows<NewsEvent>({ table: "news_events", order: "at", ascending: true, limit: 200 });
  const [f, setF] = useState({ date: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), time: "08:30", title: "", currency: "USD", impact: "high", xau: true, btc: true, forecast: "", previous: "" });
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [mins, setMins] = useState<string | null>(null);
  const block = (me.settings?.news_block_minutes ?? 15) * 60_000;

  const rows = (events.rows ?? []).filter((e) => +new Date(e.at) >= Date.now() - 24 * 3_600_000);
  const hits = (t: number) => {
    for (const w of EDGE_WINDOWS) {
      const inst = windowOnDateOf(t, w);
      if (t + block > inst.startUtc && t - block < inst.endUtc) return w.name;
    }
    return null;
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const [y, mo, d] = f.date.split("-").map(Number) as [number, number, number];
    const [hh, mm] = f.time.split(":").map(Number) as [number, number];
    if (!f.title.trim() || !y || Number.isNaN(hh)) return setMsg({ ok: false, t: "Title, date and ET time are required" });
    const at = new Date(wallToUtc(y, mo, d, hh, mm, "America/New_York")).toISOString();
    const instruments = [f.xau && "XAUUSD", f.btc && "BTCUSDT.P"].filter(Boolean);
    const { error } = await supabase.from("news_events").insert({ at, title: f.title.trim(), currency: f.currency, impact: f.impact, instruments, forecast: f.forecast || null, previous: f.previous || null });
    setMsg(error ? { ok: false, t: error.message } : { ok: true, t: "Event added" });
    if (!error) { setF({ ...f, title: "", forecast: "", previous: "" }); events.reload(); }
  };
  const remove = async (id: string) => { await supabase.from("news_events").delete().eq("id", id); events.reload(); };

  return (
    <>
      <ErrorNote error={events.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="g12">
        <div className="card flush s8">
          {rows.length === 0 ? <div style={{ padding: 16 }}><Empty>No events scheduled — add this week&apos;s releases</Empty></div> : (
            <Table head={["Day", "Event", "Impact", "ET", "UTC", "IST", "No-trade zone (IST)", "Hits window", ""]} right={[3, 4, 5]}>
              {rows.map((e) => {
                const t = +new Date(e.at);
                const w = e.impact === "high" || (e.impact === "medium" && me.settings?.news_medium_gold && e.instruments.includes("XAUUSD")) ? hits(t) : null;
                return (
                  <tr key={e.id}>
                    <td className="mono faint">{new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", timeZone: "America/New_York" })}</td>
                    <td><b style={{ fontWeight: 500 }}>{e.title}</b> <span className="faint" style={{ fontSize: 11 }}>{e.currency}{e.forecast ? ` · f ${e.forecast}` : ""}{e.previous ? ` · p ${e.previous}` : ""}</span></td>
                    <td><Chip tone={e.impact === "high" ? "down" : e.impact === "medium" ? "warn" : ""}>{e.impact.replace(/^\w/, (c) => c.toUpperCase())}</Chip></td>
                    <td className="r mono">{timeShort(t, "America/New_York")}</td>
                    <td className="r mono">{timeShort(t, "UTC")}</td>
                    <td className="r mono acc">{timeShort(t, "Asia/Kolkata")}</td>
                    <td className="mono muted">{timeShort(t - block, "Asia/Kolkata")}–{timeShort(t + block, "Asia/Kolkata")}</td>
                    <td>{w ? <Chip tone="down">{w}</Chip> : <Chip>outside</Chip>}</td>
                    <td><button className="btn ghost sm" onClick={() => remove(e.id)} aria-label={`Remove ${e.title}`}>✕</button></td>
                  </tr>
                );
              })}
            </Table>
          )}
        </div>
        <div className="s4 col" style={{ gap: 16 }}>
          <Card title="News rules">
            <div className="col" style={{ gap: 10 }}>
              <label className="fld"><span>Block new entries before and after high-impact</span>
                <div className="inp"><input inputMode="numeric" value={mins ?? String(me.settings?.news_block_minutes ?? 15)} onChange={(e) => setMins(e.target.value)} onBlur={async () => { if (mins !== null) { await me.updateSettings({ news_block_minutes: Math.max(0, Math.min(120, Number(mins) || 15)) }); setMins(null); } }} /><span className="u">min</span></div>
              </label>
              <div className="between" style={{ fontSize: 12.5 }}><span>Include medium impact for gold</span><Toggle on={!!me.settings?.news_medium_gold} onChange={(v) => me.updateSettings({ news_medium_gold: v })} label="Medium impact for gold" /></div>
              <div className="between" style={{ fontSize: 12.5 }}><span>Post-news model waits</span><Chip>30 min</Chip></div>
              <div className="between" style={{ fontSize: 12.5 }}><span>Never move stops for news</span><Chip>Locked · edge rule</Chip></div>
            </div>
          </Card>
          <Card title="Add event">
            <form onSubmit={add} className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 8 }}>
              <label className="fld" style={{ gridColumn: "1 / -1" }}><span>Event</span><div className="inp txt"><input value={f.title} placeholder="US CPI m/m" onChange={(e) => setF({ ...f, title: e.target.value })} /></div></label>
              <label className="fld"><span>Date (ET)</span><div className="inp"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div></label>
              <label className="fld"><span>Time (ET)</span><div className="inp"><input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></div></label>
              <label className="fld"><span>Impact</span><div className="inp"><select value={f.impact} onChange={(e) => setF({ ...f, impact: e.target.value })}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div></label>
              <label className="fld"><span>Currency</span><div className="inp"><input value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase().slice(0, 3) })} /></div></label>
              <label className="fld"><span>Forecast</span><div className="inp"><input value={f.forecast} onChange={(e) => setF({ ...f, forecast: e.target.value })} /></div></label>
              <label className="fld"><span>Previous</span><div className="inp"><input value={f.previous} onChange={(e) => setF({ ...f, previous: e.target.value })} /></div></label>
              <div className="row" style={{ gridColumn: "1 / -1" }}>
                <button type="button" className={`chip ${f.xau ? "acc" : ""}`} onClick={() => setF({ ...f, xau: !f.xau })}>XAUUSD</button>
                <button type="button" className={`chip ${f.btc ? "acc" : ""}`} onClick={() => setF({ ...f, btc: !f.btc })}>BTCUSDT.P</button>
                <span style={{ flex: 1 }} /><button className="btn pri sm">Add</button>
              </div>
            </form>
          </Card>
        </div>
      </section>
      <Card title="Data source">
        <p className="muted" style={{ fontSize: 12.5 }}>Events are entered here. A licensed calendar API (Trading Economics, FMP or Finnhub) can fill this table automatically later; sites without an official API are not scraped.</p>
      </Card>
    </>
  );
}
