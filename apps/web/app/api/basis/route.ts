import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { basisTick, closePosition, fundingBoard, loadConfig, openPosition, positionPnl, type PositionRow } from "@/lib/server/basis";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/basis → config, the live funding board, open positions with live P&L, closed history and
 * totals. POST /api/basis { action: "open", symbol } | { action: "close", id } | { action: "config", patch } |
 * { action: "run" } — paper actions on the funding basis trade (staff only).
 */
export async function GET(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  try {
    const cfg = await loadConfig(db);
    const [openRes, closedRes] = await Promise.all([
      db.from("basis_positions").select("*").eq("status", "open").order("opened_at", { ascending: false }),
      db.from("basis_positions").select("*").eq("status", "closed").order("closed_at", { ascending: false }).limit(100),
    ]);
    if (openRes.error) throw new Error(openRes.error.message);
    const open = (openRes.data ?? []) as PositionRow[];
    const closed = (closedRes.data ?? []) as PositionRow[];
    const board = await fundingBoard(cfg, new Set(open.map((p) => p.symbol)));
    const withPnl = (rows: PositionRow[]) => rows.map((p) => ({ ...p, pnl: positionPnl(p, board) }));
    const o = withPnl(open), c = withPnl(closed);
    const sum = (rows: typeof o, k: "net" | "funding" | "fees" | "basis") => rows.reduce((a, r) => a + r.pnl[k], 0);
    const wins = c.filter((r) => r.pnl.net > 0).length;
    return json({
      at: Date.now(), config: cfg, board, open: o, closed: c,
      totals: {
        openNet: sum(o, "net"), openFunding: sum(o, "funding"), closedNet: sum(c, "net"), closedFunding: sum(c, "funding"), closedFees: sum(c, "fees"), closedBasis: sum(c, "basis"),
        closedR: c.reduce((a, r) => a + r.pnl.r, 0), closedCount: c.length, winRate: c.length ? wins / c.length : null,
      },
    }, 0);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}

export async function POST(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; symbol?: string; id?: string; patch?: Record<string, unknown> };
    const cfg = await loadConfig(db);
    if (body.action === "config") {
      const allowed = ["enabled", "mode", "symbols", "notional", "entry_rate", "exit_rate", "max_open", "spot_fee", "perp_fee"];
      const patch = Object.fromEntries(Object.entries(body.patch ?? {}).filter(([k]) => allowed.includes(k)));
      const r = await db.from("basis_config").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1);
      if (r.error) throw new Error(r.error.message);
      return json({ ok: true });
    }
    if (body.action === "run") return json({ ok: true, note: await basisTick(db) || "nothing to do" });
    const openRes = await db.from("basis_positions").select("*").eq("status", "open");
    const open = (openRes.data ?? []) as PositionRow[];
    const board = await fundingBoard(cfg, new Set([...open.map((p) => p.symbol), ...(body.symbol ? [body.symbol] : [])]));
    if (body.action === "open" && body.symbol) {
      if (open.some((p) => p.symbol === body.symbol)) return json({ error: `${body.symbol} already has an open basis position` }, 0, 400);
      const row = board.find((b) => b.symbol === body.symbol);
      if (!row) return json({ error: "unknown symbol" }, 0, 400);
      return json({ ok: true, id: await openPosition(db, cfg, row, "manual") });
    }
    if (body.action === "close" && body.id) {
      const p = open.find((x) => x.id === body.id);
      if (!p) return json({ error: "no open position with that id" }, 0, 404);
      await closePosition(db, p, board.find((b) => b.symbol === p.symbol), "closed by hand");
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 0, 400);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
