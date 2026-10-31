import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { markAlert, sendCfdAlert } from "@/lib/server/cfdAlerts";
import { chatsFrom, type Chat } from "@/lib/server/telegram";

export const dynamic = "force-dynamic";

/**
 * POST /api/cfd/alerts
 *   { action: "taken" | "skipped", alertId, accountId? }  → mark an alert from the app
 *   { action: "test", instrument, side, entry, stop, target } → send a test alert through the full path
 */
export async function POST(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  const b = (await req.json().catch(() => null)) as { action?: string; alertId?: string; accountId?: string; instrument?: string; side?: "long" | "short"; entry?: number; stop?: number; target?: number } | null;
  if (b?.action === "taken" || b?.action === "skipped") {
    if (!b.alertId) return Response.json({ error: "alertId missing" }, { status: 400 });
    const { data } = await db.auth.getUser();
    const err = await markAlert(db, b.alertId, b.action, data.user?.email ?? "app", b.accountId);
    return Response.json(err ? { error: err } : { ok: true }, { status: err ? 500 : 200 });
  }
  if (b?.action === "test") {
    const { instrument, side, entry, stop, target } = b;
    if (!instrument || (side !== "long" && side !== "short") || ![entry, stop, target].every((x) => typeof x === "number" && x > 0)) return Response.json({ error: "instrument, side, entry, stop and target are required" }, { status: 400 });
    if ((side === "long") !== (stop! < entry!) || (side === "long") !== (target! > entry!)) return Response.json({ error: "stop and target are on the wrong side of the entry" }, { status: 400 });
    const s = await db.from("app_settings").select("integrations").eq("id", 1).maybeSingle();
    const chats = chatsFrom((s.data?.integrations as { telegram_chats?: Chat[] } | null)?.telegram_chats);
    const r = await sendCfdAlert(db, chats, { instrument, side, entry: entry!, stop: stop!, target: target!, model: "test", grade: null, why: ["Test alert from the CFD Arena"], expiresAt: Date.now() + 2 * 3_600_000 });
    if (!r) return Response.json({ error: `${instrument} is not a CFD Arena market` }, { status: 400 });
    return Response.json(r, { status: "error" in r && r.error ? 502 : 200 });
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
}
