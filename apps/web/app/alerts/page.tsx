"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { AlertLog } from "@/lib/types";
import { timeShort } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Empty, ErrorNote, Toggle } from "@/components/ui";

type Rule = { id: string; name: string; event: string; channels: string[]; enabled: boolean };
const CHANNELS = [["app", "APP"], ["push", "PUSH"], ["email", "MAIL"], ["telegram", "TG"]] as const;
const DEFAULTS: { name: string; event: string; channels: string[] }[] = [
  { name: "Price enters a planned POI", event: "in_poi", channels: ["app", "push"] },
  { name: "Liquidity swept at a POI", event: "swept", channels: ["app", "push"] },
  { name: "Signal armed · gate GO", event: "armed", channels: ["app", "push", "telegram"] },
  { name: "Order filled / closed", event: "filled", channels: ["app", "push"] },
  { name: "Copy blocked by guard", event: "copy_blocked", channels: ["app", "push"] },
  { name: "Daily loss or trade cap hit", event: "cap", channels: ["app", "push", "email"] },
  { name: "Prop room below 50%", event: "prop_room", channels: ["app", "push", "email"] },
  { name: "High-impact news in 15 min", event: "news", channels: ["app", "push"] },
  { name: "Broker session expired", event: "session", channels: ["app", "email"] },
  { name: "Payout waiting for approval", event: "payout", channels: ["app", "email"] },
];

export default function Alerts() {
  const me = useMe();
  const rules = useRows<Rule>({ table: "alert_rules", order: "name", ascending: true });
  const log = useRows<AlertLog>({ table: "alert_log", order: "at", limit: 30 });
  const [qf, setQf] = useState<string | null>(null);
  const [qt, setQt] = useState<string | null>(null);

  const seed = async () => { await supabase.from("alert_rules").insert(DEFAULTS); rules.reload(); };
  const toggleCh = async (r: Rule, ch: string) => {
    const channels = r.channels.includes(ch) ? r.channels.filter((c) => c !== ch) : [...r.channels, ch];
    await supabase.from("alert_rules").update({ channels }).eq("id", r.id); rules.reload();
  };
  const markRead = async () => { await supabase.from("alert_log").update({ read: true }).eq("read", false); log.reload(); };
  const saveQuiet = async () => {
    const ok = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    const patch: Record<string, string> = {};
    if (qf !== null && ok(qf)) patch.quiet_from = qf;
    if (qt !== null && ok(qt)) patch.quiet_to = qt;
    if (Object.keys(patch).length) await me.updateSettings(patch);
    setQf(null); setQt(null);
  };

  return (
    <>
      <ErrorNote error={rules.error || log.error} />
      <section className="g12">
        <Card span={7} title="Alert rules" right={<span className="faint" style={{ fontSize: 12 }}>App · Push · Email · Telegram</span>}>
          {(rules.rows ?? []).length === 0 ? <Empty><button className="btn pri sm" onClick={seed}>Add the standard rules</button></Empty> : (rules.rows ?? []).map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto auto", gap: 12, alignItems: "center", padding: "11px 0", borderBottom: "1px solid var(--line)" }}>
              <div className="col" style={{ gap: 2 }}><b style={{ fontSize: 13, fontWeight: 500 }}>{r.name}</b><span className="faint mono" style={{ fontSize: 11 }}>{r.event}</span></div>
              <span style={{ display: "inline-flex", gap: 4 }}>
                {CHANNELS.map(([k, l]) => <button key={k} type="button" onClick={() => toggleCh(r, k)} aria-pressed={r.channels.includes(k)} style={{ fontSize: 10.5, fontWeight: 600, padding: "3px 7px", borderRadius: 6, border: 0, background: r.channels.includes(k) ? "var(--accent-bg)" : "var(--surface-3)", color: r.channels.includes(k) ? "var(--accent-ink)" : "var(--faint)" }}>{l}</button>)}
              </span>
              <Toggle on={r.enabled} onChange={async (v) => { await supabase.from("alert_rules").update({ enabled: v }).eq("id", r.id); rules.reload(); }} label={`${r.name} alerts`} />
            </div>
          ))}
        </Card>
        <div className="s5 col" style={{ gap: 16 }}>
          <Card title="Recent" right={<button className="btn ghost sm" onClick={markRead}>Mark all read</button>}>
            {(log.rows ?? []).length === 0 ? <Empty>No alerts yet</Empty> : (
              <div className="feed">
                {(log.rows ?? []).map((a) => (
                  <div key={a.id} className="fi"><span className="t">{timeShort(+new Date(a.at), "Asia/Kolkata")}</span><div style={{ fontSize: 12.5, opacity: a.read ? 0.65 : 1 }}><b className={a.severity === "critical" ? "down" : a.severity === "warn" ? "warn" : ""}>{a.title}</b> {a.body && <span className="muted">{a.body}</span>}</div></div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Quiet hours">
            <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
              <label className="fld"><span>From (IST)</span><div className="inp"><input value={qf ?? me.settings?.quiet_from ?? ""} onChange={(e) => setQf(e.target.value)} onBlur={saveQuiet} /></div></label>
              <label className="fld"><span>To (IST)</span><div className="inp"><input value={qt ?? me.settings?.quiet_to ?? ""} onChange={(e) => setQt(e.target.value)} onBlur={saveQuiet} /></div></label>
            </div>
          </Card>
        </div>
      </section>
    </>
  );
}
