import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Telegram alerts (send-only). Every message — manual, autopilot or TradingView — is
 * written to `telegram_alerts`, so the team has one log of what went out and when.
 */

export interface Chat { id: string; label: string }

/** TELEGRAM_CHAT_IDS="-100123:Desk,-100456:Investors" plus chats saved in Settings. */
export function chatsFrom(settingsChats: Chat[] | null | undefined): Chat[] {
  const env = (process.env.TELEGRAM_CHAT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [id, ...rest] = s.split(":");
    return { id: id!.trim(), label: rest.join(":").trim() || id!.trim() };
  });
  const all = [...env, ...(settingsChats ?? [])];
  return all.filter((c, i) => c.id && all.findIndex((x) => x.id === c.id) === i);
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendTelegram(db: SupabaseClient, msg: { text: string; chats: Chat[]; kind: string; instrument?: string | null; signalId?: string | null; source: "manual" | "autopilot" | "tradingview" | "system" }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const results: { chat: string; ok: boolean; error?: string }[] = [];
  if (!msg.chats.length) return { results, error: "No Telegram chats configured" };
  for (const c of msg.chats) {
    let ok = false, error: string | undefined, messageId: number | null = null;
    if (!token) error = "TELEGRAM_BOT_TOKEN is not set";
    else {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: c.id, text: msg.text, parse_mode: "HTML", disable_web_page_preview: true }),
        });
        const j = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
        ok = j.ok;
        messageId = j.result?.message_id ?? null;
        if (!ok) error = j.description ?? `HTTP ${res.status}`;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    await db.from("telegram_alerts").insert({
      chat_id: c.id, chat_label: c.label, kind: msg.kind, instrument: msg.instrument ?? null, text: msg.text,
      status: ok ? "sent" : "failed", telegram_message_id: messageId, error: error ?? null, signal_id: msg.signalId ?? null, source: msg.source,
    });
    results.push({ chat: c.label, ok, error });
  }
  return { results, error: results.every((r) => !r.ok) ? results[0]?.error ?? "failed" : null };
}
