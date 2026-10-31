"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { CATEGORIES, prefsFrom, shouldAlert, type Category, type Notification, type NotifyPrefs } from "@/lib/notify";
import { Chip, Icon } from "@/components/ui";

/**
 * The bell: every app event as a card, unread count, in-app toasts, browser pop-ups while the tab is in
 * the background and a chime, each controlled per category in Settings → Notifications.
 */

const POLL_MS = 20_000;
const TONE: Record<string, "up" | "warn" | "down" | "info" | ""> = { success: "up", warn: "warn", critical: "down", info: "" };
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const catLabel = (c: string) => CATEGORIES.find((x) => x.id === c)?.label ?? c;

/** Per-user notification preferences (stored in notification_prefs; defaults until saved). */
export function useNotifyPrefs() {
  const [prefs, setPrefs] = useState<NotifyPrefs>(() => prefsFrom(null));
  const [lastSeen, setLastSeen] = useState<number>(Date.now());
  const [uid, setUid] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const id = data.session?.user.id ?? null;
      if (!id) return;
      const r = await supabase.from("notification_prefs").select("prefs, last_seen_at").eq("user_id", id).maybeSingle();
      if (!live) return;
      setUid(id);
      if (r.data) { setPrefs(prefsFrom(r.data.prefs)); setLastSeen(Date.parse(r.data.last_seen_at as string)); }
      else setLastSeen(Date.now() - 24 * 3_600_000);
      setReady(true);
    })();
    return () => { live = false; };
  }, []);
  const save = useCallback(async (p: NotifyPrefs) => {
    setPrefs(p);
    if (!uid) return "Not signed in";
    const r = await supabase.from("notification_prefs").upsert({ user_id: uid, prefs: p, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    return r.error?.message ?? null;
  }, [uid]);
  const markSeen = useCallback(async () => {
    const now = new Date();
    setLastSeen(now.getTime());
    if (uid) await supabase.from("notification_prefs").upsert({ user_id: uid, last_seen_at: now.toISOString() }, { onConflict: "user_id" });
  }, [uid]);
  return { prefs, save, lastSeen, markSeen, ready };
}

/** Short two-note chime (louder and lower for critical). */
function chime(critical: boolean) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const notes = critical ? [440, 330] : [880, 1175];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(critical ? 0.25 : 0.12, ctx.currentTime + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.25);
    });
    setTimeout(() => ctx.close(), 800);
  } catch { /* audio blocked until the user interacts */ }
}

function NotificationCard({ n, unread, onOpen }: { n: Notification; unread: boolean; onOpen: (n: Notification) => void }) {
  return (
    <button type="button" onClick={() => onOpen(n)} className="card" style={{ textAlign: "left", padding: "9px 11px", display: "flex", flexDirection: "column", gap: 3, cursor: "pointer", borderLeft: unread ? "3px solid var(--accent)" : "3px solid transparent", boxShadow: "none", width: "100%" }}>
      <span className="between" style={{ gap: 8 }}>
        <b style={{ fontWeight: 500, fontSize: 12.5 }}>{n.title}</b>
        <span className="faint mono" style={{ fontSize: 10.5, flex: "0 0 auto" }}>{ago(n.at)}</span>
      </span>
      {n.body && <span className="muted" style={{ fontSize: 12, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-wrap" }}>{n.body}</span>}
      <span className="row" style={{ gap: 4 }}><Chip tone={TONE[n.severity] ?? ""}>{catLabel(n.category)}</Chip>{n.instrument && <span className="faint" style={{ fontSize: 10.5 }}>{n.instrument}</span>}</span>
    </button>
  );
}

export default function NotificationBell() {
  const router = useRouter();
  const { prefs, lastSeen, markSeen, ready } = useNotifyPrefs();
  const [rows, setRows] = useState<Notification[]>([]);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Category | "all">("all");
  const [toasts, setToasts] = useState<Notification[]>([]);
  const maxId = useRef<number | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const box = useRef<HTMLDivElement>(null);

  const visible = (n: Notification) => prefsRef.current.cats[n.category]?.bell !== false && !(n.instrument && prefsRef.current.mutedInstruments.includes(n.instrument));

  const load = useCallback(async () => {
    const r = await supabase.from("notifications").select("*").gte("at", new Date(Date.now() - 3 * 86_400_000).toISOString()).order("id", { ascending: false }).limit(80);
    if (r.error) { setMissing(true); return; }
    const list = (r.data ?? []) as Notification[];
    setRows(list);
    const top = list[0]?.id ?? 0;
    if (maxId.current === null) { maxId.current = top; return; }
    const fresh = list.filter((n) => n.id > maxId.current! && visible(n)).reverse();
    maxId.current = Math.max(maxId.current, top);
    let sound = false, critical = false;
    const pops: Notification[] = [];
    for (const n of fresh) {
      const a = shouldAlert(n, prefsRef.current);
      if (a.popup) pops.push(n);
      if (a.sound) { sound = true; critical ||= n.severity === "critical"; }
    }
    if (pops.length) {
      if (document.visibilityState === "hidden" && "Notification" in window && Notification.permission === "granted") {
        for (const n of pops.slice(-3)) {
          const os = new Notification(n.title, { body: n.body ?? undefined, tag: `n${n.id}` });
          os.onclick = () => { window.focus(); if (n.link) router.push(n.link); os.close(); };
        }
      } else {
        setToasts((t) => [...t, ...pops].slice(-4));
        for (const n of pops) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== n.id)), 8_000);
      }
    }
    if (sound) chime(critical);
  }, [router]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready) return;
    load();
    const t = setInterval(load, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [load, ready]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (missing) return null;
  const shown = rows.filter(visible);
  const unread = shown.filter((n) => Date.parse(n.at) > lastSeen).length;
  const list = shown.filter((n) => filter === "all" || n.category === filter).slice(0, 40);
  const openItem = (n: Notification) => { setOpen(false); setToasts((t) => t.filter((x) => x.id !== n.id)); if (n.link) router.push(n.link); };

  return (
    <div ref={box} style={{ position: "relative" }}>
      <button type="button" className="ibtn" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open} onClick={() => { setOpen((v) => !v); if (!open && unread) markSeen(); }} style={{ position: "relative" }}>
        <Icon d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        {unread > 0 && <span className="mono" style={{ position: "absolute", top: -3, right: -3, minWidth: 17, height: 17, padding: "0 4px", borderRadius: 99, background: "var(--down)", color: "#fff", fontSize: 10, display: "grid", placeItems: "center", fontWeight: 600 }}>{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <div role="dialog" aria-label="Notifications" style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: "min(400px, calc(100vw - 32px))", maxHeight: "min(640px, 80vh)", display: "flex", flexDirection: "column", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 14, boxShadow: "0 16px 48px rgba(0,0,0,.25)", zIndex: 60 }}>
          <div className="between" style={{ padding: "12px 14px 8px" }}>
            <b style={{ fontSize: 14, fontWeight: 600 }}>Notifications</b>
            <span className="row" style={{ gap: 6 }}>
              <Link className="btn ghost sm" href="/notifications" onClick={() => setOpen(false)}>All</Link>
              <Link className="btn ghost sm" href="/settings#notifications" onClick={() => setOpen(false)}>Controls</Link>
            </span>
          </div>
          <div className="row" style={{ gap: 4, padding: "0 14px 8px", flexWrap: "wrap" }}>
            {[{ id: "all", label: "All" }, ...CATEGORIES].map((c) => {
              const n = c.id === "all" ? shown.length : shown.filter((x) => x.category === c.id).length;
              if (c.id !== "all" && !n) return null;
              return <button key={c.id} type="button" className={`btn sm ${filter === c.id ? "pri" : "ghost"}`} onClick={() => setFilter(c.id as Category | "all")}>{c.label} {n}</button>;
            })}
          </div>
          <div style={{ overflowY: "auto", padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            {list.length === 0 ? <div className="faint" style={{ fontSize: 12.5, padding: 18, textAlign: "center" }}>Nothing yet. Trades, setups, heads-ups and system events land here.</div>
              : list.map((n) => <NotificationCard key={n.id} n={n} unread={Date.parse(n.at) > lastSeen} onOpen={openItem} />)}
          </div>
        </div>
      )}

      {toasts.length > 0 && (
        <div aria-live="polite" style={{ position: "fixed", right: 16, bottom: 84, width: "min(360px, calc(100vw - 32px))", display: "flex", flexDirection: "column", gap: 8, zIndex: 70 }}>
          {toasts.map((n) => (
            <div key={n.id} style={{ position: "relative", boxShadow: "0 10px 30px rgba(0,0,0,.25)", borderRadius: 14 }}>
              <NotificationCard n={n} unread onOpen={openItem} />
              <button type="button" className="ibtn" aria-label="Dismiss" onClick={() => setToasts((t) => t.filter((x) => x.id !== n.id))} style={{ position: "absolute", top: 4, right: 4, width: 22, height: 22, fontSize: 12 }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { NotificationCard };
