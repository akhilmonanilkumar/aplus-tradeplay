import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INSTRUMENTS, type InstrumentId } from "@aplus/engine";
import { escapeHtml, sendTelegram, type Chat } from "@/lib/server/telegram";

/**
 * One approved trade, in the shape every destination receives.
 * Telegram is the only destination today. Broker and prop-firm adapters (REST APIs or
 * webhook bridges) implement `Executor` and get the same ticket; nothing upstream changes.
 */
export interface TradeTicket {
  signalId: string;
  instrument: InstrumentId;
  side: "long" | "short";
  orderType: "limit";
  entry: number;
  stop: number;
  target: number;
  targetLabel: string;
  rr: number;
  /** Cancel the limit if unfilled by then. */
  expiresAt: number;
  score: number;
  /** Why this trade: grade, context, edge, timing. */
  why: string[];
  /** What else was on the board and why it lost. */
  alternatives: string[];
  accounts: { accountId: string; name: string; qty: number; unit: string; riskAmount: number; blocked: string | null }[];
  paper: boolean;
  source: string;
}

export interface ExecResult { destination: string; ok: boolean; ref?: string | null; error?: string | null }

export interface Executor {
  id: string;
  /** True for destinations that move real money. */
  live: boolean;
  submit(t: TradeTicket): Promise<ExecResult>;
}

const fmt = (x: number, d = 2) => x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

export function ticketMessage(t: TradeTicket): string {
  const d = INSTRUMENTS[t.instrument].digits;
  const mins = Math.max(1, Math.round((t.expiresAt - Date.now()) / 60_000));
  const lines = [
    `🎯 <b>Best setup · ${escapeHtml(t.instrument)} ${t.side === "long" ? "LONG" : "SHORT"} · ${t.score}/100</b>`,
    `${t.side === "long" ? "Buy" : "Sell"} limit ${fmt(t.entry, d)} · SL ${fmt(t.stop, d)} · TP ${fmt(t.target, d)}${t.targetLabel ? ` (${escapeHtml(t.targetLabel)})` : ""} · ${fmt(t.rr)}R`,
    escapeHtml(t.why.join(" · ")),
  ];
  const sized = t.accounts.filter((a) => !a.blocked);
  if (sized.length) lines.push(`Size: ${sized.map((a) => `${escapeHtml(a.name)} ${a.qty} ${escapeHtml(a.unit)} (risk ${usd(a.riskAmount)})`).join(" · ")}`);
  const blocked = t.accounts.filter((a) => a.blocked);
  if (blocked.length) lines.push(`Skipped: ${blocked.map((a) => `${escapeHtml(a.name)} — ${escapeHtml(a.blocked!)}`).join(" · ")}`);
  lines.push(`Valid ~${mins} min · skip if TP trades before the fill`);
  if (t.alternatives.length) lines.push(`<i>Also on the board: ${escapeHtml(t.alternatives.join(" · "))}</i>`);
  lines.push(`<i>${escapeHtml(t.source)}${t.paper ? " · tracked as paper" : ""}</i>`);
  return lines.join("\n");
}

/** Telegram destination: the trade goes to the desk's chats; staff place it by hand. */
export function telegramExecutor(db: SupabaseClient, chats: Chat[]): Executor {
  return {
    id: "telegram",
    live: false,
    async submit(t) {
      const r = await sendTelegram(db, { text: ticketMessage(t), chats, kind: "PICK", instrument: t.instrument, signalId: t.signalId, source: "autopilot" });
      return { destination: "telegram", ok: !r.error, error: r.error };
    },
  };
}
