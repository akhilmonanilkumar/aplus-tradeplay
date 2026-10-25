"use client";

import { useEffect, useState } from "react";
import { EDGE_WINDOWS, currentOrNextWindow, isFxWeekend } from "@aplus/engine";
import { timeShort } from "@/lib/fmt";
import { Badge } from "@/components/ui";

const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

/** London Q and NY Q, anchored to New York time (DST-safe), shown in IST and UTC. */
export default function Sessions() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (now === null) return <div className="card h-[188px] p-5" />;
  const weekend = isFxWeekend(now);
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Sessions</h2>
        <span className="num text-xs text-mute">IST {timeShort(now, "Asia/Kolkata")} · UTC {timeShort(now, "UTC")} · NY {timeShort(now, "America/New_York")}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {EDGE_WINDOWS.map((w) => {
          const inst = currentOrNextWindow(now, w);
          const progress = inst.live ? (now - inst.startUtc) / (inst.endUtc - inst.startUtc) : 0;
          return (
            <div key={w.id} className={`rounded-2xl p-4 ${inst.live ? "bg-accent/10 ring-1 ring-accent/40" : "bg-raised"}`}>
              <div className="flex items-center justify-between">
                <span className="font-medium">{w.name}</span>
                {inst.live ? <Badge tone="accent">Live · {dur(inst.endUtc - now)} left</Badge> : <Badge>{weekend ? "Weekend" : `in ${dur(inst.startUtc - now)}`}</Badge>}
              </div>
              <div className="num mt-3 text-xl font-semibold">{timeShort(inst.startUtc, "Asia/Kolkata")}–{timeShort(inst.endUtc, "Asia/Kolkata")} <span className="text-xs font-normal text-mute">IST</span></div>
              <div className="num mt-1 text-xs text-mute">{timeShort(inst.startUtc, "UTC")}–{timeShort(inst.endUtc, "UTC")} UTC · {inst.weekday}</div>
              <div className="mt-3 h-1.5 rounded-full bg-line/60">
                <div className="h-1.5 rounded-full bg-accent" style={{ width: `${progress * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
