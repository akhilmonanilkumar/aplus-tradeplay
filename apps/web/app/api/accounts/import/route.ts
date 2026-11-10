import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { errMsg, json } from "@/lib/server/http";
import { parseCTraderHistory } from "@/lib/ctraderHistory";
import { importHistory } from "@/lib/server/historyImport";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 4_000_000;

/**
 * POST { accountId, text, dryRun? } → import a cTrader history export (CSV / semicolon / tab) into that
 * account's journal: each trade once, linked to the logged setup it was taken from. Staff only.
 */
export async function POST(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as { accountId?: string; text?: string; dryRun?: boolean };
  if (!body.accountId || typeof body.text !== "string") return json({ error: "accountId and the file text are required" }, 0, 400);
  if (body.text.length > MAX_BYTES) return json({ error: "File too large (4 MB at most); export a shorter range" }, 0, 413);
  const acc = await db.from("trading_accounts").select("id, name").eq("id", body.accountId).maybeSingle();
  if (!acc.data) return json({ error: "Account not found" }, 0, 404);
  const parsed = parseCTraderHistory(body.text);
  if (parsed.errors.length) return json({ error: parsed.errors.join("; "), columns: parsed.columns }, 0, 422);
  if (!parsed.rows.length) return json({ error: "No closed trades found in the file" }, 0, 422);
  if (parsed.rows.length > 10_000) return json({ error: "More than 10,000 trades; export a shorter range" }, 0, 413);
  if (body.dryRun) return json({ ok: true, found: parsed.rows.length, skipped: parsed.skipped });
  try {
    const r = await importHistory(db, acc.data.id, parsed.rows);
    return json({ ok: true, ...r, skipped: r.skipped + parsed.skipped, found: parsed.rows.length });
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 500);
  }
}
