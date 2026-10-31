import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INSTRUMENTS, LONDON_Q, NY_Q, pnlMultiplier, zonedParts, type InstrumentId } from "@aplus/engine";
import { PROMPTS, aiConfigured, complete } from "@/lib/server/ai";
import { loadQuote, marketStatuses } from "@/lib/server/feeds";
import type { CalEvent } from "@/lib/server/news";
import { escapeHtml, sendTelegram, type Chat } from "@/lib/server/telegram";
import { SEVERITY_RANK, deskOf, telegramFrom, type Category, type Severity } from "@/lib/notify";

/**
 * Notifications written by the server: proactive heads-ups from each autopilot pass (news ahead,
 * trades near stop or target, feeds down, pre-session briefs) and the Telegram routing for every
 * category. App events (trades, orders, setups, basis, money, settings) are written by database
 * triggers; this module only adds what no table records.
 */

export interface NewNotification {
  category: Category; severity: Severity; title: string; body?: string | null; instrument?: string | null;
  link?: string | null; key: string; meta?: Record<string, unknown>;
}

/** Insert notifications, skipping any whose dedupe key already exists. */
export async function notify(db: SupabaseClient, items: NewNotification[]): Promise<number> {
  if (!items.length) return 0;
  const rows = items.map((n) => {
    const desk = deskOf(n.instrument);
    return {
      category: n.category, severity: n.severity, title: n.title, body: n.body ?? null, instrument: n.instrument ?? null, desk,
      link: n.link ?? (desk && n.instrument ? `/desk/${desk}?i=${encodeURIComponent(n.instrument)}` : null), dedupe_key: n.key, meta: n.meta ?? {},
    };
  });
  const r = await db.from("notifications").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id");
  if (r.error) throw new Error(r.error.message);
  return r.data?.length ?? 0;
}

const istStamp = (t: number) => new Date(t).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const hourKey = (t: number) => new Date(t).toISOString().slice(0, 13);

/** High-impact releases in the next 30 minutes. */
function newsAhead(calendar: CalEvent[], now: number): NewNotification[] {
  return calendar.filter((e) => e.impact === "high" && e.desks.length && e.at > now && e.at - now <= 30 * 60_000).map((e) => ({
    category: "news" as const, severity: "warn" as const,
    title: `${e.currency} ${e.title} in ${Math.round((e.at - now) / 60_000)} min`,
    body: `${istStamp(e.at)} IST · desks ${e.desks.join(", ")}${e.forecast ? ` · forecast ${e.forecast}` : ""}${e.previous ? ` · previous ${e.previous}` : ""}. No new entries in the news window.`,
    link: "/", key: `news:${e.id}`, meta: { at: e.at, desks: e.desks },
  }));
}

/** Open paper trades that reached +1R, are within 0.25R of target, or are 75% of the way to the stop. */
async function tradeWatch(db: SupabaseClient): Promise<NewNotification[]> {
  const open = await db.from("trades").select("id, instrument, side, entry, stop, target, qty").eq("source", "paper").is("exit", null);
  const out: NewNotification[] = [];
  for (const t of (open.data ?? []) as { id: string; instrument: string; side: "long" | "short"; entry: number; stop: number; target: number | null; qty: number }[]) {
    if (!(t.instrument in INSTRUMENTS)) continue;
    const q = await loadQuote(t.instrument as InstrumentId).catch(() => null);
    if (!q) continue;
    const risk = Math.abs(t.entry - t.stop);
    if (!risk) continue;
    const r = ((t.side === "long" ? 1 : -1) * (q.last - t.entry)) / risk;
    const toTarget = t.target === null ? null : ((t.side === "long" ? 1 : -1) * (t.target - q.last)) / risk;
    const pnl = (t.side === "long" ? 1 : -1) * (q.last - t.entry) * t.qty * pnlMultiplier(t.instrument);
    const d = INSTRUMENTS[t.instrument as InstrumentId].digits;
    const base = { instrument: t.instrument, meta: { trade_id: t.id, r: Number(r.toFixed(2)) } };
    const where = `${t.instrument} ${t.side} at ${q.last.toFixed(d)} (${r >= 0 ? "+" : ""}${r.toFixed(2)}R, ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)})`;
    if (toTarget !== null && toTarget <= 0.25 && toTarget > 0) out.push({ ...base, category: "headsup", severity: "success", title: `${t.instrument} near target`, body: `${where}. Target ${Number(t.target).toFixed(d)}.`, key: `hu:target:${t.id}` });
    else if (r >= 1) out.push({ ...base, category: "headsup", severity: "success", title: `${t.instrument} reached +1R`, body: `${where}. The plan manages the rest; no change unless the plan says so.`, key: `hu:1r:${t.id}` });
    if (r <= -0.75) out.push({ ...base, category: "headsup", severity: "warn", title: `${t.instrument} near stop`, body: `${where}. Stop ${t.stop.toFixed(d)}. Let the stop do its job.`, key: `hu:stop:${t.id}` });
  }
  return out;
}

/** Markets that are open but whose feed is down or has stopped printing bars (once an hour). */
async function feedWatch(now: number): Promise<NewNotification[]> {
  const ms = await marketStatuses(now).catch(() => []);
  return ms.filter((m) => m.status === "down" || m.status === "stale").map((m) => ({
    category: "feed" as const, severity: "warn" as const, instrument: m.id, link: "/",
    title: `${m.label} feed ${m.status}`,
    body: m.status === "down" ? (m.error ?? "No provider answered.") : `${m.feed}: no new 5M bar for ${m.barAgeMin} min while the market is open.`,
    key: `feed:${m.id}:${hourKey(now)}`,
  }));
}

/**
 * AI pre-session brief per live desk in the 30 minutes before London Q and NY Q (once per window).
 * Narrative only: it explains the engine's state, it never decides.
 */
async function briefs(db: SupabaseClient, now: number, ctx: (desk: "gold" | "btc") => Promise<unknown>, model: string | null): Promise<NewNotification[]> {
  if (!aiConfigured().provider) return [];
  const ny = zonedParts(now, LONDON_Q.tz);
  const mins = ny.hour * 60 + ny.minute;
  const w = [LONDON_Q, NY_Q].find((x) => { const s = x.start.hour * 60 + x.start.minute; return mins >= s - 30 && mins < s; });
  if (!w) return [];
  const day = `${ny.year}-${ny.month}-${ny.day}`;
  const out: NewNotification[] = [];
  for (const desk of ["gold", "btc"] as const) {
    const key = `brief:${desk}:${day}:${w.id}`;
    const seen = await db.from("notifications").select("id").eq("dedupe_key", key).maybeSingle();
    if (seen.data) continue;
    try {
      const context = await ctx(desk);
      const r = await complete({ system: PROMPTS.brief, user: `Context (JSON):\n${JSON.stringify(context).slice(0, 12000)}`, maxTokens: 400, model });
      if (r.text) out.push({ category: "headsup", severity: "info", title: `${desk === "gold" ? "Gold" : "BTC"} brief before ${w.name}`, body: r.text, link: `/desk/${desk}`, key, meta: { model: r.model, desk } });
    } catch { /* a missing brief is not worth failing the pass */ }
  }
  return out;
}

/** Heads-ups for one autopilot pass. */
export async function headsUps(db: SupabaseClient, p: { calendar: CalEvent[]; briefContext: (desk: "gold" | "btc") => Promise<unknown>; model?: string | null }): Promise<number> {
  const now = Date.now();
  const [a, b, c] = await Promise.all([tradeWatch(db).catch(() => []), feedWatch(now), briefs(db, now, p.briefContext, p.model ?? null)]);
  return notify(db, [...newsAhead(p.calendar, now), ...a, ...b, ...c]);
}

const ICON: Record<Severity, string> = { info: "ℹ️", success: "✅", warn: "⚠️", critical: "🚨" };

/**
 * Send recent notifications to the firm's Telegram chats per the routing in Settings
 * (app_settings.integrations.notify). Each notification is sent at most once.
 */
export async function dispatchTelegram(db: SupabaseClient, chats: Chat[], routingRaw: unknown): Promise<number> {
  if (!chats.length) return 0;
  const routing = telegramFrom(routingRaw);
  const due = await db.from("notifications").select("id, category, severity, title, body, instrument, link").is("telegram_at", null).gte("at", new Date(Date.now() - 15 * 60_000).toISOString()).order("at").limit(20);
  const rows = (due.data ?? []) as { id: number; category: Category; severity: Severity; title: string; body: string | null; instrument: string | null; link: string | null }[];
  let sent = 0;
  for (const n of rows) {
    const go = routing.cats[n.category] && SEVERITY_RANK[n.severity] >= SEVERITY_RANK[routing.minSeverity];
    if (go) {
      await sendTelegram(db, { text: `${ICON[n.severity]} <b>${escapeHtml(n.title)}</b>${n.body ? `\n${escapeHtml(n.body).slice(0, 900)}` : ""}`, chats, kind: n.category.toUpperCase(), instrument: n.instrument, source: "system" });
      sent++;
    }
    await db.from("notifications").update({ telegram_at: new Date().toISOString() }).eq("id", n.id);
  }
  return sent;
}

/** Keep 45 days. */
export async function pruneNotifications(db: SupabaseClient) {
  await db.from("notifications").delete().lt("at", new Date(Date.now() - 45 * 86_400_000).toISOString());
}
