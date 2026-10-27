import { INSTRUMENTS, pnlMultiplier, type InstrumentId } from "@aplus/engine";
import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { instrumentOk, loadCandles, loadQuote } from "@/lib/server/feeds";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/paper/live[?i=] → everything in a trade right now, marked to the latest price: paper-account
 * trades (open R and P&L after costs) and ledger setups the bot is tracking without an account (open R;
 * most are setups the gate rejected), plus paper orders still waiting for a fill. Polled every few
 * seconds by the live P&L card.
 */
export async function GET(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  const only = new URL(req.url).searchParams.get("i");
  try {
    let tq = db.from("trades").select("id, signal_id, account_id, instrument, side, model, entry, stop, target, qty, planned_r, opened_at, trading_accounts(name)").eq("source", "paper").is("exit", null).order("opened_at", { ascending: false });
    let sq = db.from("signals").select("id, instrument, side, model, entry, stop, target, rr, filled_at, created_at, meta").in("source", ["autopilot", "selector"]).eq("outcome", "filled").order("filled_at", { ascending: false }).limit(200);
    let oq = db.from("orders").select("id, side, entry, stop, target, created_at, signals!inner(instrument, model)").eq("action", "PAPER").eq("status", "queued").order("created_at", { ascending: false }).limit(50);
    if (only) { tq = tq.eq("instrument", only); sq = sq.eq("instrument", only); oq = oq.eq("signals.instrument", only); }
    const [open, tracked, pending] = await Promise.all([tq, sq, oq]);
    if (open.error) throw new Error(open.error.message);
    if (tracked.error) throw new Error(tracked.error.message);
    type Open = { id: string; signal_id: string | null; instrument: string; side: "long" | "short"; model: string | null; entry: number; stop: number; target: number | null; qty: number; planned_r: number | null; opened_at: string; trading_accounts: { name: string } | null };
    type Tracked = { id: string; instrument: string; side: "long" | "short"; model: string | null; entry: number; stop: number; target: number | null; rr: number | null; filled_at: string | null; created_at: string; meta: { tradeable?: boolean; strategy?: string; paper?: { blockers?: string[] } } | null };
    const trades = (open.data ?? []) as unknown as Open[];
    const onAccount = new Set(trades.map((t) => t.signal_id).filter(Boolean));
    const ledger = ((tracked.data ?? []) as unknown as Tracked[]).filter((s) => !onAccount.has(s.id));
    const ids = [...new Set([...trades, ...ledger].map((t) => t.instrument).filter(instrumentOk))] as InstrumentId[];
    // A quote where the instrument has one; otherwise the forming entry-TF bar (cached, no extra vendor calls).
    const marks = new Map(await Promise.all(ids.map(async (id) => {
      const q = await loadQuote(id).catch(() => null);
      if (q) return [id, { price: q.last, source: q.source }] as const;
      const c = await loadCandles(id, INSTRUMENTS[id].ltf, 3).catch(() => null);
      const bar = c?.forming ?? c?.candles.at(-1);
      return [id, bar ? { price: bar.c, source: `${c!.source} (${INSTRUMENTS[id].ltf} bar)` } : null] as const;
    })));
    const openR = (side: "long" | "short", entry: number, stop: number, price: number | undefined) => {
      if (price === undefined) return null;
      const r = ((side === "long" ? 1 : -1) * (price - entry)) / Math.abs(entry - stop);
      return Number.isFinite(r) ? Number(r.toFixed(2)) : null;
    };

    const rows = trades.map((t) => {
      const m = marks.get(t.instrument as InstrumentId) ?? null;
      const def = INSTRUMENTS[t.instrument as InstrumentId];
      const mult = pnlMultiplier(t.instrument);
      const fees = def ? def.costRate * t.entry * t.qty * mult : 0;
      return {
        id: t.id, kind: "paper" as const, gate: "traded", instrument: t.instrument, side: t.side, model: t.model, account: t.trading_accounts?.name ?? null,
        entry: Number(t.entry), stop: Number(t.stop), target: t.target === null ? null : Number(t.target), qty: Number(t.qty), plannedR: t.planned_r === null ? null : Number(t.planned_r),
        openedAt: t.opened_at, price: m?.price ?? null, priceSource: m?.source ?? null,
        uR: openR(t.side, Number(t.entry), Number(t.stop), m?.price),
        uPnl: m ? Number(((t.side === "long" ? 1 : -1) * (m.price - t.entry) * t.qty * mult - fees).toFixed(2)) : null,
        digits: def?.digits ?? 2,
      };
    });
    const watched = ledger.map((t) => {
      const m = marks.get(t.instrument as InstrumentId) ?? null;
      return {
        id: t.id, kind: "ledger" as const, gate: t.meta?.tradeable ? "would trade" : t.meta?.paper?.blockers?.[0] ?? "rejected",
        instrument: t.instrument, side: t.side, model: t.model === "S" && t.meta?.strategy ? `S · ${t.meta.strategy}` : t.model, account: null,
        entry: Number(t.entry), stop: Number(t.stop), target: t.target === null ? null : Number(t.target), qty: 0, plannedR: t.rr === null ? null : Number(t.rr),
        openedAt: t.filled_at ?? t.created_at, price: m?.price ?? null, priceSource: m?.source ?? null,
        uR: openR(t.side, Number(t.entry), Number(t.stop), m?.price), uPnl: null,
        digits: INSTRUMENTS[t.instrument as InstrumentId]?.digits ?? 2,
      };
    });
    const priced = rows.filter((r) => r.uPnl !== null);
    return json({
      at: Date.now(),
      trades: rows,
      tracked: watched,
      pending: (pending.data ?? []).map((o) => ({ id: o.id, instrument: (o.signals as unknown as { instrument: string }).instrument, model: (o.signals as unknown as { model: string | null }).model, side: o.side, entry: Number(o.entry), stop: Number(o.stop), target: o.target === null ? null : Number(o.target), createdAt: o.created_at })),
      totals: {
        open: rows.length, uPnl: Number(priced.reduce((a, r) => a + (r.uPnl ?? 0), 0).toFixed(2)), uR: Number(priced.reduce((a, r) => a + (r.uR ?? 0), 0).toFixed(2)),
        tracked: watched.length, trackedR: Number(watched.reduce((a, r) => a + (r.uR ?? 0), 0).toFixed(2)),
      },
    }, 0);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
