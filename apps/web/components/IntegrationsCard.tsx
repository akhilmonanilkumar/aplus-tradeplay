"use client";

import { useEffect, useState } from "react";
import { staffGet } from "@/lib/market";
import type { Integrations } from "@/lib/types";
import { useMe } from "@/components/Shell";
import { Card, Chip } from "@/components/ui";

type Status = { ai: { provider: string | null; model: string }; keys: Record<string, boolean> };

const KEYS: { k: string; what: string; where: string }[] = [
  { k: "OPENROUTER_API_KEY", what: "AI desk analyst, briefs, news reads, trade reviews", where: "openrouter.ai → Keys" },
  { k: "TELEGRAM_BOT_TOKEN", what: "Send Telegram alerts", where: "@BotFather → /newbot" },
  { k: "OANDA_API_KEY", what: "Broker-grade XAU/USD candles (free practice account works)", where: "OANDA → Manage API access" },
  { k: "OANDA_ACCOUNT_ID", what: "Live XAU/USD bid/ask from OANDA", where: "OANDA account number" },
  { k: "FRED_API_KEY", what: "10Y real yield (TIPS) for the gold desk", where: "fred.stlouisfed.org → API keys (free)" },
  { k: "FINNHUB_API_KEY", what: "Extra news headlines", where: "finnhub.io (free tier)" },
  { k: "SUPABASE_SERVICE_ROLE_KEY", what: "Autopilot, selector, investor invites", where: "Supabase → Project settings → API" },
  { k: "AUTOPILOT_SECRET", what: "Lets the 5-minute scheduler run the autopilot", where: "Any long random string" },
];

export default function IntegrationsCard() {
  const me = useMe();
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const integ: Integrations = { telegram_chats: [], ai_model: null, ...(me.settings?.integrations ?? {}) };
  const [chat, setChat] = useState({ id: "", label: "" });
  const [model, setModel] = useState(integ.ai_model ?? "");
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => { staffGet<Status>("/api/integrations").then(setStatus).catch((e: Error) => setErr(e.message)); }, []);
  const save = async (patch: Partial<Integrations>, note = "Saved") => {
    const e = await me.updateSettings({ integrations: { ...integ, ...patch } });
    setSaved(e ?? note);
  };

  return (
    <section className="g12">
      <Card span={7} title="Data, AI & alert integrations" right={status?.ai.provider ? <Chip tone="up">AI · {status.ai.model}</Chip> : <Chip tone="warn">AI off</Chip>}>
        {err && <p className="down" style={{ fontSize: 12 }}>{err}</p>}
        <p className="faint" style={{ fontSize: 12, marginBottom: 8 }}>Keys live in Vercel → Project → Settings → Environment Variables, never in the browser or database. Redeploy after adding one.</p>
        {KEYS.map((x) => (
          <div key={x.k} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
            <div className="col" style={{ gap: 1 }}><b className="mono" style={{ fontWeight: 500, fontSize: 12 }}>{x.k}</b><span className="faint" style={{ fontSize: 11.5 }}>{x.what} · {x.where}</span></div>
            {status ? <Chip tone={status.keys[x.k] ? "up" : ""}>{status.keys[x.k] ? "set" : "missing"}</Chip> : <Chip>…</Chip>}
          </div>
        ))}
        <div className="lbl-u" style={{ margin: "14px 0 6px" }}>AI model (OpenRouter id)</div>
        <div className="row">
          <div className="inp txt" style={{ flex: 1 }}><input value={model} placeholder={status?.ai.model || "anthropic/claude-sonnet-4.5"} onChange={(e) => setModel(e.target.value)} aria-label="AI model" /></div>
          <button className="btn sm" onClick={() => save({ ai_model: model.trim() || null })}>Save</button>
        </div>
      </Card>
      <Card span={5} title="Telegram">
        <div className="lbl-u" style={{ marginBottom: 6 }}>Telegram chats</div>
        {integ.telegram_chats.length === 0 && <p className="faint" style={{ fontSize: 12 }}>None saved here{status?.keys.TELEGRAM_CHAT_IDS ? " (TELEGRAM_CHAT_IDS is set in Vercel)" : ""}.</p>}
        {integ.telegram_chats.map((c) => (
          <div key={c.id} className="between" style={{ padding: "4px 0", fontSize: 12.5 }}>
            <span>{c.label} <span className="mono faint">{c.id}</span></span>
            <button className="btn ghost sm" onClick={() => save({ telegram_chats: integ.telegram_chats.filter((x) => x.id !== c.id) })}>Remove</button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 6 }}>
          <div className="inp" style={{ width: 150 }}><input placeholder="-1001234567890" aria-label="Chat id" value={chat.id} onChange={(e) => setChat({ ...chat, id: e.target.value.trim() })} /></div>
          <div className="inp txt" style={{ flex: 1, minWidth: 100 }}><input placeholder="Label" aria-label="Chat label" value={chat.label} onChange={(e) => setChat({ ...chat, label: e.target.value })} /></div>
          <button className="btn sm" disabled={!/^-?\d+$/.test(chat.id) && !/^@\w+$/.test(chat.id)} onClick={() => { save({ telegram_chats: [...integ.telegram_chats, { id: chat.id, label: chat.label || chat.id }] }); setChat({ id: "", label: "" }); }}>Add</button>
        </div>
        {saved && <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>{saved}</p>}
      </Card>
    </section>
  );
}
