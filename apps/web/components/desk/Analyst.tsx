"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { staffPost } from "@/lib/market";
import { supabase } from "@/lib/supabase";
import { timeShort } from "@/lib/fmt";
import type { Notification } from "@/lib/notify";
import { Card, Chip } from "@/components/ui";

/**
 * Desk agent: a chat over the engine's live state that also reads screenshots (paste, drop or attach a
 * chart, ticket or position), plus proactive heads-ups for this desk from the autopilot, shown in the
 * same timeline. It explains and flags; the engine decides GO.
 */

type Msg = { id: string; role: "user" | "assistant"; text: string; images?: string[]; imageCount?: number; at: number; model?: string; error?: boolean };
type Item = { kind: "msg"; at: number; m: Msg } | { kind: "headsup"; at: number; n: Notification };

const MAX_IMAGES = 4;
const QUICK = ["Brief me for the next session", "Why no trade right now?", "What invalidates this setup?", "Review my screenshot against the engine"];
const HEADSUP_CATS = ["headsup", "setup", "news", "feed"];
const TONE: Record<string, "up" | "warn" | "down" | "info" | ""> = { success: "up", warn: "warn", critical: "down", info: "info" };

/** Downscale a picture to ≤1600 px and JPEG so a screenshot fits the request. */
async function toDataUrl(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  for (let i = 0; i < 4; i++) {
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", i ? 0.72 : 0.85);
    if (url.length < 1_400_000) return url;
    scale *= 0.75;
  }
  throw new Error("Screenshot too large");
}

const store = (desk: string) => `deskchat:${desk}`;
function loadHistory(desk: string): Msg[] {
  try { return JSON.parse(localStorage.getItem(store(desk)) ?? "[]") as Msg[]; } catch { return []; }
}
function saveHistory(desk: string, msgs: Msg[]) {
  // Text only: screenshots stay in memory for this session.
  try { localStorage.setItem(store(desk), JSON.stringify(msgs.slice(-40).map(({ images, ...m }) => ({ ...m, imageCount: images?.length ?? m.imageCount })))); } catch { /* storage full or blocked */ }
}

export default function Analyst({ desk, context, notes }: { desk: string; context: unknown; notes: { t: number; title: string; body: string }[] }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [heads, setHeads] = useState<Notification[]>([]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMsgs(loadHistory(desk)); }, [desk]);
  useEffect(() => { saveHistory(desk, msgs); }, [desk, msgs]);

  // Proactive heads-ups for this desk (last 12 h), refreshed every 30 s.
  useEffect(() => {
    let stop = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const r = await supabase.from("notifications").select("*").eq("desk", desk).in("category", HEADSUP_CATS).gte("at", new Date(Date.now() - 12 * 3_600_000).toISOString()).order("at", { ascending: false }).limit(20);
      if (!stop && !r.error) setHeads((r.data ?? []) as Notification[]);
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, [desk]);

  const items: Item[] = [...msgs.map((m) => ({ kind: "msg" as const, at: m.at, m })), ...heads.map((n) => ({ kind: "headsup" as const, at: Date.parse(n.at), n }))].sort((a, b) => a.at - b.at);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [items.length, busy]);

  const addFiles = useCallback(async (files: Blob[]) => {
    setErr(null);
    const pics = files.filter((f) => f.type.startsWith("image/")).slice(0, MAX_IMAGES);
    try {
      const urls = await Promise.all(pics.map(toDataUrl));
      setImages((x) => [...x, ...urls].slice(0, MAX_IMAGES));
    } catch (e) { setErr((e as Error).message); }
  }, []);

  const send = async (raw: string) => {
    const q = raw.trim();
    if ((!q && !images.length) || busy) return;
    const user: Msg = { id: crypto.randomUUID(), role: "user", text: q || "What do you see in this screenshot?", images: images.length ? images : undefined, at: Date.now() };
    const next = [...msgs, user];
    setMsgs(next); setText(""); setImages([]); setBusy(true); setErr(null);
    try {
      const r = await staffPost<{ answer: string; model: string }>("/api/ai", {
        task: "chat", desk, context,
        turns: next.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.imageCount && !m.images ? `${m.text}\n[${m.imageCount} screenshot(s) shared earlier, no longer attached]` : m.text, images: m.images })),
      });
      setMsgs((x) => [...x, { id: crypto.randomUUID(), role: "assistant", text: r.answer, model: r.model, at: Date.now() }]);
    } catch (e) {
      setMsgs((x) => [...x, { id: crypto.randomUUID(), role: "assistant", text: (e as Error).message, at: Date.now(), error: true }]);
    }
    setBusy(false);
  };

  return (
    <Card title="Desk agent" right={<>
      <Chip tone="acc" dot>explains, never decides</Chip>
      {msgs.length > 0 && <button className="btn ghost sm" onClick={() => setMsgs([])}>Clear chat</button>}
    </>}>
      {notes.length > 0 && (
        <div className="col" style={{ gap: 4, padding: "8px 10px", marginBottom: 8, borderRadius: 10, background: "var(--surface-2)", fontSize: 12 }}>
          {notes.slice(0, 3).map((n, i) => <div key={i}><b style={{ fontWeight: 500 }}>{n.title}</b> <span className="muted">{n.body}</span></div>)}
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles([...e.dataTransfer.files]); }}
        style={{ maxHeight: 440, minHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: 2, outline: drag ? "2px dashed var(--accent)" : "none", borderRadius: 10 }}
      >
        {items.length === 0 && <div className="faint" style={{ fontSize: 12.5, padding: "24px 8px", textAlign: "center" }}>Ask about the setup, or paste a chart screenshot (Ctrl/⌘+V), drop one here, or attach it. Heads-ups for this desk appear here as they happen.</div>}
        {items.map((it) => it.kind === "headsup" ? (
          <div key={`n${it.n.id}`} style={{ alignSelf: "stretch", borderLeft: "3px solid var(--accent)", padding: "6px 10px", background: "var(--accent-bg)", borderRadius: 8, fontSize: 12.5 }}>
            <div className="between"><b style={{ fontWeight: 500 }}>{it.n.title}</b><span className="row" style={{ gap: 4 }}><Chip tone={TONE[it.n.severity] ?? ""}>{it.n.category === "headsup" ? "heads-up" : it.n.category}</Chip><span className="faint mono" style={{ fontSize: 10.5 }}>{timeShort(it.at, "Asia/Kolkata")}</span></span></div>
            {it.n.body && <div className="muted" style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>{it.n.body}</div>}
          </div>
        ) : (
          <div key={it.m.id} style={{ alignSelf: it.m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%", padding: "8px 11px", borderRadius: 12, fontSize: 12.5, background: it.m.role === "user" ? "var(--surface-3)" : "var(--surface-2)", color: it.m.error ? "var(--down)" : undefined }}>
            {it.m.images && <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 6 }}>{it.m.images.map((u, i) => <img key={i} src={u} alt="Shared screenshot" style={{ maxHeight: 120, maxWidth: 200, borderRadius: 6, border: "1px solid var(--line)" }} />)}</div>}
            {!it.m.images && it.m.imageCount ? <div className="faint" style={{ fontSize: 11 }}>📷 {it.m.imageCount} screenshot{it.m.imageCount > 1 ? "s" : ""}</div> : null}
            <div style={{ whiteSpace: "pre-wrap" }}>{it.m.text}</div>
            <div className="faint mono" style={{ fontSize: 10, marginTop: 3 }}>{timeShort(it.m.at, "Asia/Kolkata")}{it.m.model ? ` · ${it.m.model}` : ""}</div>
          </div>
        ))}
        {busy && <div className="faint" style={{ fontSize: 12, padding: "4px 8px" }}>Agent is thinking…</div>}
        <div ref={endRef} />
      </div>

      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {QUICK.map((q) => <button key={q} type="button" className="btn ghost sm" disabled={busy} onClick={() => send(q)}>{q}</button>)}
      </div>

      {images.length > 0 && (
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          {images.map((u, i) => (
            <span key={i} style={{ position: "relative" }}>
              <img src={u} alt={`Attachment ${i + 1}`} style={{ height: 56, borderRadius: 6, border: "1px solid var(--line)" }} />
              <button type="button" className="ibtn" aria-label="Remove screenshot" onClick={() => setImages((x) => x.filter((_, j) => j !== i))} style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, fontSize: 11 }}>×</button>
            </span>
          ))}
        </div>
      )}
      {err && <div className="down" style={{ fontSize: 12, marginTop: 6 }}>{err}</div>}

      <form className="row" style={{ marginTop: 8, alignItems: "flex-end", gap: 6 }} onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
        <button type="button" className="btn sm" aria-label="Attach screenshot" title="Attach screenshot" disabled={images.length >= MAX_IMAGES} onClick={() => fileRef.current?.click()}>📎</button>
        <div className="inp txt" style={{ flex: 1, height: "auto", minHeight: 36 }}>
          <textarea
            aria-label="Message the desk agent" rows={1} value={text} placeholder="Message the desk agent, or paste a screenshot…"
            style={{ width: "100%", resize: "none", border: 0, background: "transparent", color: "inherit", font: "inherit", padding: "8px 0", outline: "none", maxHeight: 140 }}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => { const files = [...e.clipboardData.items].filter((x) => x.kind === "file").map((x) => x.getAsFile()).filter((f): f is File => !!f); if (files.length) { e.preventDefault(); addFiles(files); } }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}
          />
        </div>
        <button className="btn pri sm" disabled={busy || (!text.trim() && !images.length)}>Send</button>
      </form>
    </Card>
  );
}
