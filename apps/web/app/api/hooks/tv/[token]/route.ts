import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

const SYMBOLS: Record<string, string> = { XAUUSD: "XAUUSD", "OANDA:XAUUSD": "XAUUSD", BTCUSDT: "BTCUSDT.P", "BTCUSDT.P": "BTCUSDT.P", "BINANCE:BTCUSDT.P": "BTCUSDT.P" };

/** TradingView alert → alert log. Never places orders: alerts only wake the copilot. */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return Response.json({ error: "not configured" }, { status: 503 });
  const { token } = await ctx.params;
  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const s = await db.from("app_settings").select("webhook_token").eq("id", 1).single();
  const want = Buffer.from(String(s.data?.webhook_token ?? ""));
  const got = Buffer.from(String(token ?? ""));
  if (!want.length || want.length !== got.length || !timingSafeEqual(want, got)) return Response.json({ error: "forbidden" }, { status: 403 });

  const raw = (await req.text()).slice(0, 4000);
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = { message: raw }; }
  const symbol = SYMBOLS[String(body.symbol ?? "").toUpperCase()] ?? String(body.symbol ?? "—");
  const side = String(body.side ?? "").toLowerCase();
  const price = Number(body.price);
  const title = `TradingView · ${symbol}${side ? ` ${side}` : ""}${Number.isFinite(price) ? ` @ ${price}` : ""}`;
  const { error } = await db.from("alert_log").insert({ title, body: String(body.note ?? body.message ?? "").slice(0, 500) || null, severity: "info" });
  if (error) return Response.json({ error: "store failed" }, { status: 500 });
  return Response.json({ ok: true });
}
