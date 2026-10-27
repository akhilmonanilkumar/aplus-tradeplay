import { INSTRUMENTS, pnlMultiplier, type InstrumentId } from "@aplus/engine";
import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { instrumentOk, loadCandles, loadQuote } from "@/lib/server/feeds";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper/live → open paper trades marked to the latest price, with unrealised R and P&L,
 * plus the paper orders still waiting for a fill. Polled every few seconds by the live P&L card.
 */
export async function GET(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  try {
    const [open, pending] = await Promise.all([
      db.from("trades").select("id, account_id, instrument, side, model, entry, stop, target, qty, planned_r, opened_at, trading_accounts(name)").eq("source", "paper").is("exit", null).order("opened_at", { ascending: false }),
      db.from("orders").select("id, side, entry, stop, target, created_at, signals!inner(instrument, model)").eq("action", "PAPER").eq("status", "queued").order("created_at", { ascending: false }).limit(50),
    ]);
    if (open.error) throw new Error(open.error.message);
    type Open = { id: string; instrument: string; side: "long" | "short"; model: string | null; entry: number; stop: number; target: number | null; qty: number; planned_r: number | null; opened_at: string; trading_accounts: { name: string } | null };
    const trades = (open.data ?? []) as unknown as Open[];
    const ids = [...new Set(trades.map((t) => t.instrument).filter(instrumentOk))] as InstrumentId[];
    // A quote where the instrument has one; otherwise the forming entry-TF bar (cached, no extra vendor calls).
    const marks = new Map(await Promise.all(ids.map(async (id) => {
      const q = await loadQuote(id).catch(() => null);
      if (q) return [id, { price: q.last, source: q.source, ts: q.ts }] as const;
      const c = await loadCandles(id, INSTRUMENTS[id].ltf, 3).catch(() => null);
      const bar = c?.forming ?? c?.candles.at(-1);
      return [id, bar ? { price: bar.c, source: `${c!.source} (${INSTRUMENTS[id].ltf} bar)`, ts: Date.now() } : null] as const;
    })));
    const rows = trades.map((t) => {
      const m = marks.get(t.instrument as InstrumentId) ?? null;
      const dir = t.side === "long" ? 1 : -1;
      const risk = Math.abs(t.entry - t.stop) || NaN;
      const def = INSTRUMENTS[t.instrument as InstrumentId];
      const mult = pnlMultiplier(t.instrument);
      const fees = def ? def.costRate * t.entry * t.qty * mult : 0;
      const uR = m ? (dir * (m.price - t.entry)) / risk : null;
      return {
        id: t.id, instrument: t.instrument, side: t.side, model: t.model, account: t.trading_accounts?.name ?? null,
        entry: Number(t.entry), stop: Number(t.stop), target: t.target === null ? null : Number(t.target), qty: Number(t.qty), plannedR: t.planned_r === null ? null : Number(t.planned_r),
        openedAt: t.opened_at, price: m?.price ?? null, priceSource: m?.source ?? null,
        uR: uR === null || !Number.isFinite(uR) ? null : Number(uR.toFixed(2)),
        uPnl: m ? Number((dir * (m.price - t.entry) * t.qty * mult - fees).toFixed(2)) : null,
        digits: def?.digits ?? 2,
      };
    });
    const priced = rows.filter((r) => r.uPnl !== null);
    return json({
      at: Date.now(),
      trades: rows,
      pending: (pending.data ?? []).map((o) => ({ id: o.id, instrument: (o.signals as unknown as { instrument: string }).instrument, model: (o.signals as unknown as { model: string | null }).model, side: o.side, entry: Number(o.entry), stop: Number(o.stop), target: o.target === null ? null : Number(o.target), createdAt: o.created_at })),
      totals: { open: rows.length, uPnl: Number(priced.reduce((a, r) => a + (r.uPnl ?? 0), 0).toFixed(2)), uR: Number(priced.reduce((a, r) => a + (r.uR ?? 0), 0).toFixed(2)) },
    }, 0);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
