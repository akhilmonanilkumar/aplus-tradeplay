import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { chatsFrom, sendTelegram, type Chat } from "@/lib/server/telegram";

export const dynamic = "force-dynamic";

/** POST /api/telegram { text, kind?, instrument?, chatIds? } — staff send; every message is logged. */
export async function POST(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  const body = (await req.json().catch(() => null)) as { text?: string; kind?: string; instrument?: string; chatIds?: string[] } | null;
  const text = String(body?.text ?? "").slice(0, 4000).trim();
  if (!text) return Response.json({ error: "Message is empty" }, { status: 400 });
  const s = await db.from("app_settings").select("integrations").eq("id", 1).maybeSingle();
  let chats = chatsFrom((s.data?.integrations as { telegram_chats?: Chat[] } | null)?.telegram_chats);
  if (body?.chatIds?.length) chats = chats.filter((c) => body.chatIds!.includes(c.id));
  const r = await sendTelegram(db, { text, chats, kind: body?.kind ?? "manual", instrument: body?.instrument ?? null, source: "manual" });
  return Response.json(r, { status: r.error ? 502 : 200 });
}
