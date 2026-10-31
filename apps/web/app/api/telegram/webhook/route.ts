import { timingSafeEqual } from "node:crypto";
import { hasSecret, serviceClient, staffFromRequest, unauthorized } from "@/lib/server/auth";
import { markAlert } from "@/lib/server/cfdAlerts";
import { chatsFrom, telegramApi, type Chat } from "@/lib/server/telegram";

export const dynamic = "force-dynamic";

type Update = { callback_query?: { id: string; data?: string; from?: { username?: string; first_name?: string }; message?: { chat: { id: number }; message_id: number } } };

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * POST /api/telegram/webhook ← Telegram (secret in X-Telegram-Bot-Api-Secret-Token).
 * Handles the Taken / Skip buttons on CFD alerts, only from the configured chats.
 */
export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret || !same(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) return new Response("forbidden", { status: 403 });
  const db = serviceClient();
  if (!db) return new Response("no database", { status: 503 });
  const u = (await req.json().catch(() => ({}))) as Update;
  const q = u.callback_query;
  const m = q?.data?.match(/^cfd:([ts]):([0-9a-f-]{36})$/);
  if (!q) return Response.json({ ok: true });
  if (!m || !q.message) {
    await telegramApi("answerCallbackQuery", { callback_query_id: q.id });
    return Response.json({ ok: true });
  }
  const s = await db.from("app_settings").select("integrations").eq("id", 1).maybeSingle();
  const chats = chatsFrom((s.data?.integrations as { telegram_chats?: Chat[] } | null)?.telegram_chats);
  if (!chats.some((c) => c.id === String(q.message!.chat.id))) {
    await telegramApi("answerCallbackQuery", { callback_query_id: q.id, text: "This chat is not allowed to act on alerts" });
    return Response.json({ ok: true });
  }
  const action = m[1] === "t" ? "taken" : "skipped";
  const who = q.from?.username ? `@${q.from.username}` : q.from?.first_name ?? "telegram";
  const err = await markAlert(db, m[2]!, action, who);
  await telegramApi("answerCallbackQuery", { callback_query_id: q.id, text: err ? `Could not save: ${err}` : action === "taken" ? "Marked taken" : "Skipped" });
  if (!err) {
    // Keep the cTrader links, replace Taken / Skip with the result.
    const legs = await db.from("cfd_alert_legs").select("lots, link, trading_accounts(name)").eq("alert_id", m[2]!);
    const links = (legs.data ?? []).filter((l) => l.link).map((l) => [{ text: `Open in cTrader · ${(l.trading_accounts as unknown as { name: string } | null)?.name ?? ""} · ${Number(l.lots).toFixed(2)}`, url: l.link as string }]);
    await telegramApi("editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [...links, [{ text: `${action === "taken" ? "✅ Taken" : "⏭ Skipped"} by ${who}`, callback_data: "cfd:done" }]] } });
  }
  return Response.json({ ok: true });
}

/** PUT /api/telegram/webhook → register this URL with Telegram (staff, or the autopilot secret). */
export async function PUT(req: Request) {
  if (!(await staffFromRequest(req)) && !hasSecret(req, process.env.AUTOPILOT_SECRET)) return unauthorized();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) return Response.json({ error: "Set TELEGRAM_WEBHOOK_SECRET in Vercel first" }, { status: 400 });
  const url = `${process.env.APP_URL || new URL(req.url).origin}/api/telegram/webhook`;
  const r = await telegramApi("setWebhook", { url, secret_token: secret, allowed_updates: ["callback_query"] });
  return Response.json({ url, ...r }, { status: r.ok ? 200 : 502 });
}
