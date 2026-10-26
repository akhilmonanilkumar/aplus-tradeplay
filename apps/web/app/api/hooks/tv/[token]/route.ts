import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { normalizeInstrument } from "@aplus/engine";
import { chatsFrom, escapeHtml, sendTelegram, type Chat } from "@/lib/server/telegram";

export const dynamic = "force-dynamic";

/** TradingView alert → alert log (and Telegram when enabled in Settings). Never places orders. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return Response.json({ error: "not configured" }, { status: 503 });
  const { token } = await ctx.params;
  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const s = await db.from("app_settings").select("webhook_token, integrations").eq("id", 1).single();
  const want = Buffer.from(String(s.data?.webhook_token ?? ""));
  const got = Buffer.from(String(token ?? ""));
  if (!want.length || want.length !== got.length || !timingSafeEqual(want, got)) return Response.json({ error: "forbidden" }, { status: 403 });

  const raw = (await req.text()).slice(0, 4000);
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = { message: raw }; }
  const symbol = normalizeInstrument(String(body.symbol ?? "")) ?? String(body.symbol ?? "—");
  const side = String(body.side ?? "").toLowerCase();
  const price = Number(body.price);
  const title = `TradingView · ${symbol}${side ? ` ${side}` : ""}${Number.isFinite(price) ? ` @ ${price}` : ""}`;
  const { error } = await db.from("alert_log").insert({ title, body: String(body.note ?? body.message ?? "").slice(0, 500) || null, severity: "info" });
  if (error) return Response.json({ error: "store failed" }, { status: 500 });
  const integ = s.data?.integrations as { tv_to_telegram?: boolean; telegram_chats?: Chat[] } | null;
  if (integ?.tv_to_telegram) {
    const note = String(body.note ?? body.message ?? "").slice(0, 500);
    await sendTelegram(db, { text: `📈 <b>${escapeHtml(title)}</b>${note ? `\n${escapeHtml(note)}` : ""}`, chats: chatsFrom(integ.telegram_chats), kind: "tradingview", instrument: symbol, source: "tradingview" });
  }
  return Response.json({ ok: true });
}
