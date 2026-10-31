"use client";

import { useState } from "react";
import { INSTRUMENT_IDS } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useMe } from "@/components/Shell";
import { useNotifyPrefs } from "@/components/Notifications";
import { CATEGORIES, telegramFrom, type Category, type NotifyPrefs, type Severity } from "@/lib/notify";
import { Card, Chip, Note } from "@/components/ui";

/**
 * Notification controls. Per user: what shows in the bell, pop-ups, sound, quiet hours, minimum
 * severity and muted markets. Firm-wide (staff): which categories go to the Telegram chats.
 */

const SEVERITIES: { v: Severity; l: string }[] = [{ v: "info", l: "Everything" }, { v: "success", l: "Success and above" }, { v: "warn", l: "Warnings and critical" }, { v: "critical", l: "Critical only" }];

function Check({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <input type="checkbox" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} />;
}

export default function NotificationSettings() {
  const me = useMe();
  const { prefs, save, ready } = useNotifyPrefs();
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(() => (typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"));
  const tg = telegramFrom(me.settings?.integrations?.notify);

  const update = async (p: NotifyPrefs) => {
    const err = await save(p);
    setMsg(err ? { ok: false, t: err } : { ok: true, t: "Saved" });
  };
  const setCat = (c: Category, k: "bell" | "popup" | "sound", v: boolean) => update({ ...prefs, cats: { ...prefs.cats, [c]: { ...prefs.cats[c], [k]: v } } });
  const setTg = async (patch: Partial<typeof tg>) => {
    const next = { ...tg, ...patch, cats: { ...tg.cats, ...(patch.cats ?? {}) } };
    const err = await me.updateSettings({ integrations: { ...(me.settings?.integrations ?? { telegram_chats: [], ai_model: null }), notify: next } });
    setMsg(err ? { ok: false, t: err } : { ok: true, t: "Telegram routing saved" });
  };
  const askPermission = async () => { if ("Notification" in window) setPerm(await Notification.requestPermission()); };
  const test = async () => {
    const r = await supabase.from("notifications").insert({ category: "system", severity: "info", title: "Test notification", body: "If you can read this, the bell works. Pop-ups and sound follow your settings.", link: "/settings#notifications" });
    setMsg(r.error ? { ok: false, t: r.error.message } : { ok: true, t: "Test sent: it arrives within 20 seconds" });
  };

  return (
    <Card span={12} id="notifications" title="Notifications" right={<>
      {perm === "granted" ? <Chip tone="up" dot>Browser pop-ups allowed</Chip> : perm === "unsupported" ? <Chip>Browser pop-ups unsupported</Chip> : <button className="btn sm" onClick={askPermission}>{perm === "denied" ? "Pop-ups blocked in the browser" : "Allow browser pop-ups"}</button>}
      <button className="btn sm" onClick={test}>Send test</button>
    </>}>
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      {!ready ? <div className="faint" style={{ fontSize: 12.5 }}>Loading…</div> : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead><tr><th>Category</th><th className="r">Bell</th><th className="r">Pop-up</th><th className="r">Sound</th><th className="r">Telegram (firm)</th></tr></thead>
              <tbody>
                {CATEGORIES.map((c) => (
                  <tr key={c.id}>
                    <td><b style={{ fontWeight: 500 }}>{c.label}</b><div className="faint" style={{ fontSize: 11 }}>{c.what}</div></td>
                    <td className="r"><Check on={prefs.cats[c.id].bell} onChange={(v) => setCat(c.id, "bell", v)} label={`${c.label} in the bell`} /></td>
                    <td className="r"><Check on={prefs.cats[c.id].popup} onChange={(v) => setCat(c.id, "popup", v)} label={`${c.label} pop-ups`} /></td>
                    <td className="r"><Check on={prefs.cats[c.id].sound} onChange={(v) => setCat(c.id, "sound", v)} label={`${c.label} sound`} /></td>
                    <td className="r"><Check on={tg.cats[c.id]} onChange={(v) => setTg({ cats: { ...tg.cats, [c.id]: v } })} label={`${c.label} to Telegram`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="g12" style={{ marginTop: 14 }}>
            <label className="fld s4"><span>Pop-ups and sound for</span>
              <div className="inp"><select value={prefs.minSeverity} onChange={(e) => update({ ...prefs, minSeverity: e.target.value as Severity })}>{SEVERITIES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}</select></div>
            </label>
            <label className="fld s4"><span>Telegram for</span>
              <div className="inp"><select value={tg.minSeverity} onChange={(e) => setTg({ minSeverity: e.target.value as Severity })}>{SEVERITIES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}</select></div>
            </label>
            <div className="fld s4"><span>Quiet hours (IST, critical still alerts)</span>
              <div className="row" style={{ gap: 6 }}>
                <Check on={prefs.quiet.on} onChange={(v) => update({ ...prefs, quiet: { ...prefs.quiet, on: v } })} label="Quiet hours on" />
                <div className="inp" style={{ width: 96 }}><input type="time" value={prefs.quiet.from} onChange={(e) => update({ ...prefs, quiet: { ...prefs.quiet, from: e.target.value } })} aria-label="Quiet from" /></div>
                <span className="faint">to</span>
                <div className="inp" style={{ width: 96 }}><input type="time" value={prefs.quiet.to} onChange={(e) => update({ ...prefs, quiet: { ...prefs.quiet, to: e.target.value } })} aria-label="Quiet to" /></div>
              </div>
            </div>
          </section>

          <div className="fld" style={{ marginTop: 12 }}><span>Muted markets (hidden from the bell and pop-ups)</span>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {INSTRUMENT_IDS.map((i) => {
                const muted = prefs.mutedInstruments.includes(i);
                return <button key={i} type="button" className={`btn sm ${muted ? "pri" : "ghost"}`} aria-pressed={muted} onClick={() => update({ ...prefs, mutedInstruments: muted ? prefs.mutedInstruments.filter((x) => x !== i) : [...prefs.mutedInstruments, i] })}>{muted ? "Muted · " : ""}{i}</button>;
              })}
            </div>
          </div>
          <p className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
            Bell, pop-ups and sound are yours alone. Telegram goes to the firm&apos;s chats (Integrations) for every staff member; setups and trades also follow each market&apos;s alert events on the Autopilot page.
            Browser pop-ups appear while the app is open in a background tab; in a visible tab they show as cards in the corner.
          </p>
        </>
      )}
    </Card>
  );
}
