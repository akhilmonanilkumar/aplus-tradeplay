import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CTRADER_SPECS, INSTRUMENTS, TF_MS, modelName, strategyName, toCTraderSymbol, venueKey, venuesFor, type InstrumentId } from "@aplus/engine";
import { edgeScore, rankSetups, setupState, type Edge, type FailKind, type SetupStatus } from "@/lib/cfdSetups";
import { instrumentOk, loadQuote } from "@/lib/server/feeds";

/**
 * Every paper setup logged on the CFD markets today, marked to the live price and ranked by its strategy's
 * record on the CFD venue (paper since the League restart, the backtest, the stage). This is the list to trade
 * by hand from: where to enter, the stop and the target, how far price is from the entry, and which setups
 * failed (stopped, expired, ran away) so the board shows what did not work as well as what did.
 */

export interface RankedSetup {
  id: string; instrument: string; symbol: string; side: "long" | "short"; digits: number;
  model: string | null; strategy: string | null; name: string; detail: string | null; grade: string | null; window: string | null;
  entry: number; stop: number; target: number; rr: number; market: boolean;
  createdAt: string; filledAt: string | null; closedAt: string | null; expiresAt: string | null;
  status: SetupStatus; fail: FailKind | null; reason: string; toEntryR: number | null; r: number | null; lateOk: boolean;
  price: number | null; edge: Edge; stage: string | null; rank: number | null;
}

type Sig = {
  id: string; instrument: string; side: "long" | "short"; model: string | null; grade: string | null; session_window: string | null;
  entry: number; stop: number; target: number; rr: number | null; created_at: string; outcome: string; filled_at: string | null; closed_at: string | null; net_r: number | null; result_r: number | null;
  meta: { strategy?: string; entryType?: string; detail?: string } | null;
};
type Cand = { key: string; stage: string; stats: { paper?: { n: number; expectancy: number; profitFactor: number | null; winRate: number; lowerBound: number } } | null; backtest: { trades: number; avgR?: number | null; profitFactor: number | null; pass?: boolean } | null };

export const isCfdMarket = (id: string) => instrumentOk(id) && !!toCTraderSymbol(id) && venuesFor(id).includes("cfd");

const ENDED_SHOW_MS = 12 * 3_600_000;

export async function cfdSetups(db: SupabaseClient, now = Date.now(), prices?: Map<string, number | null>): Promise<RankedSetup[]> {
  const [sigRes, candRes] = await Promise.all([
    db.from("signals").select("id, instrument, side, model, grade, session_window, entry, stop, target, rr, created_at, outcome, filled_at, closed_at, net_r, result_r, meta")
      .in("source", ["autopilot", "selector"]).eq("state", "ARMED").gte("created_at", new Date(now - 24 * 3_600_000).toISOString())
      .order("created_at", { ascending: false }).limit(400),
    db.from("strategy_candidates").select("key, stage, stats, backtest").eq("venue", "cfd"),
  ]);
  if (sigRes.error) throw new Error(sigRes.error.message);
  const sigs = ((sigRes.data ?? []) as Sig[]).filter((s) => isCfdMarket(s.instrument));
  const cands = new Map(((candRes.data ?? []) as Cand[]).map((c) => [c.key, c]));

  // One quote per market (cached in the feed layer); the live board passes the ones it already has.
  const px = new Map(prices ?? []);
  const need = [...new Set(sigs.map((s) => s.instrument))].filter((i) => !px.has(i));
  await Promise.all(need.map(async (i) => px.set(i, await loadQuote(i as InstrumentId).then((q) => q.last).catch(() => null))));

  const out = sigs.map((s) => {
    const id = s.instrument as InstrumentId;
    const symbol = toCTraderSymbol(id)!;
    const entry = Number(s.entry), stop = Number(s.stop), target = Number(s.target);
    const market = s.meta?.entryType === "market";
    const st = setupState({
      side: s.side, entry, stop, target, createdAt: Date.parse(s.created_at), market, outcome: s.outcome,
      filledAt: s.filled_at ? Date.parse(s.filled_at) : null, closedAt: s.closed_at ? Date.parse(s.closed_at) : null,
      resultR: s.net_r !== null ? Number(s.net_r) : s.result_r !== null ? Number(s.result_r) : null,
    }, px.get(s.instrument) ?? null, TF_MS[INSTRUMENTS[id].ltf], now);
    const c = cands.get(venueKey("cfd", s.instrument, s.model, s.meta?.strategy));
    const risk = Math.abs(entry - stop);
    return {
      id: s.id, instrument: s.instrument, symbol, side: s.side, digits: CTRADER_SPECS[symbol]?.digits ?? 2,
      model: s.model, strategy: s.meta?.strategy ?? null, name: s.model === "S" ? strategyName(s.meta?.strategy) : `Model ${s.model} · ${modelName(s.model)}`,
      detail: s.meta?.detail ?? null, grade: s.grade, window: s.session_window,
      entry, stop, target, rr: s.rr !== null ? Number(s.rr) : risk ? Math.round((Math.abs(target - entry) / risk) * 100) / 100 : 0, market,
      createdAt: s.created_at, filledAt: s.filled_at, closedAt: s.closed_at, expiresAt: st.expiresAt ? new Date(st.expiresAt).toISOString() : null,
      status: st.status, fail: st.fail, reason: st.reason, toEntryR: st.toEntryR, r: st.r, lateOk: st.lateOk,
      price: st.status === "won" || st.status === "failed" ? null : px.get(s.instrument) ?? null,
      edge: edgeScore({ stage: c?.stage ?? null, paper: c?.stats?.paper ?? null, backtest: c?.backtest ?? null }), stage: c?.stage ?? null,
    };
  }).filter((x) => x.status === "enter" || x.status === "waiting" || x.status === "in_trade" || now - Date.parse(x.closedAt ?? x.createdAt) <= ENDED_SHOW_MS);

  return rankSetups(out);
}
