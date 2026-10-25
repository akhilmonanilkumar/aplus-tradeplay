"use client";

import { useEffect, useState } from "react";
import { EDGE_WINDOWS, currentOrNextWindow, isFxWeekend, wallToUtc, zonedParts } from "@aplus/engine";
import { timeShort } from "@/lib/fmt";
import { Card, Chip } from "@/components/ui";

const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return `${h ? `${h}h ` : ""}${m % 60}m`;
};
const MARKETS = [
  { name: "Sydney", tz: "Australia/Sydney", a: 7, b: 16 },
  { name: "Tokyo", tz: "Asia/Tokyo", a: 9, b: 18 },
  { name: "London", tz: "Europe/London", a: 8, b: 17 },
  { name: "New York", tz: "America/New_York", a: 8, b: 17 },
];
const minOfDay = (ts: number, tz: string) => { const p = zonedParts(ts, tz); return p.hour * 60 + p.minute; };
const et = (h: number) => `${String(h).padStart(2, "0")}:00`;

export default function SessionsCard({ span = 4 }: { span?: 4 | 6 | 12 }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (now === null) return <Card span={span} title="Sessions"><div style={{ height: 260 }} /></Card>;

  const nowPct = minOfDay(now, "Asia/Kolkata") / 14.4;
  return (
    <Card span={span} title="Sessions" right={<Chip>{isFxWeekend(now) ? "Weekend · gold closed · BTC 24/7" : "Markets open"}</Chip>}>
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 8 }}>
        <div><div className="lbl">New York</div><div className="kv sm">{timeShort(now, "America/New_York")}</div></div>
        <div><div className="lbl">UTC</div><div className="kv sm">{timeShort(now, "UTC")}</div></div>
        <div><div className="lbl">IST</div><div className="kv sm acc">{timeShort(now, "Asia/Kolkata")}</div></div>
      </div>
      {EDGE_WINDOWS.map((w) => {
        const inst = currentOrNextWindow(now, w);
        return (
          <div key={w.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "4px 10px", padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
            <div className="col" style={{ gap: 2 }}>
              <b style={{ fontSize: 13 }}>{w.name} <span className="faint" style={{ fontWeight: 400 }}>· {et(w.start.hour)}–{et(w.end.hour)} ET</span></b>
              <span className="mono muted" style={{ fontSize: 12 }}>{timeShort(inst.startUtc, "UTC")}–{timeShort(inst.endUtc, "UTC")} UTC · {timeShort(inst.startUtc, "Asia/Kolkata")}–{timeShort(inst.endUtc, "Asia/Kolkata")} IST</span>
            </div>
            {inst.live ? <Chip tone="up">Live · {dur(inst.endUtc - now)} left</Chip> : <Chip>{inst.weekday} · in {dur(inst.startUtc - now)}</Chip>}
          </div>
        );
      })}
      <div className="lbl-u" style={{ margin: "14px 0 8px" }}>Market sessions · IST 24h</div>
      {MARKETS.map((m) => {
        const p = zonedParts(now, m.tz);
        const st = wallToUtc(p.year, p.month, p.day, m.a, 0, m.tz), en = wallToUtc(p.year, p.month, p.day, m.b, 0, m.tz);
        const s = minOfDay(st, "Asia/Kolkata"), e = minOfDay(en, "Asia/Kolkata");
        const segs = e > s ? [[s, e - s]] : [[s, 1440 - s], [0, e]];
        return (
          <div key={m.name} style={{ display: "grid", gridTemplateColumns: "70px minmax(0,1fr) 96px", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>{m.name}</span>
            <div className="tl">
              {segs.map(([l, w], i) => <i key={i} style={{ left: `${l! / 14.4}%`, width: `${w! / 14.4}%` }} />)}
              <b style={{ left: `${nowPct}%` }} />
            </div>
            <span className="mono faint" style={{ fontSize: 11, textAlign: "right" }}>{timeShort(st, "Asia/Kolkata")}–{timeShort(en, "Asia/Kolkata")}</span>
          </div>
        );
      })}
    </Card>
  );
}
