import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { basisPnl, basisSignal, breakEvenSettlements, fundingForShort, roundTripCost, settlementApr, type BasisPnl, type BasisSignal } from "@aplus/engine";
import { cached, getJson } from "@/lib/server/http";

/**
 * Funding basis trade on paper: long spot + short the Binance USDⓈ-M perpetual of the same size.
 * Live funding comes from Binance (predicted rate, settled history, mark, index) and spot books.
 * Each autopilot pass accrues the settlements that printed since the last pass, closes positions whose
 * funding turned negative and opens new ones where the carry is positive. P&L is kept apart from the
 * trading accounts.
 */

export interface BasisConfig {
  enabled: boolean; mode: "off" | "paper"; symbols: string[]; notional: number;
  entry_rate: number; exit_rate: number; max_open: number; spot_fee: number; perp_fee: number;
}

export interface BoardRow {
  symbol: string; spot: number | null; mark: number; index: number; basisPct: number | null;
  predicted: number; nextFundingAt: number; lastSettled: number | null; avg3d: number | null; avg7d: number | null;
  apr: number; avgApr7d: number | null; breakEven: number | null; history: { t: number; rate: number }[];
  signal: BasisSignal; open: boolean;
}

export interface PositionRow {
  id: string; symbol: string; status: "open" | "closed"; qty: number; notional: number;
  spot_entry: number; perp_entry: number; spot_exit: number | null; perp_exit: number | null;
  entry_rate: number | null; entry_avg3d: number | null; funding: number; funding_count: number; last_funding_at: string | null;
  fees: number; spot_fee: number; perp_fee: number; opened_at: string; closed_at: string | null; exit_reason: string | null; source: string;
}

type Premium = { symbol: string; markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number };
type Settled = { symbol: string; fundingTime: number; fundingRate: string; markPrice: string };

const num = (x: unknown) => Number(x);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Predicted funding, mark and index for every perp (one call), cached briefly. */
const premiums = () => cached("basis:premium", 10_000, () => getJson<Premium[]>("https://fapi.binance.com/fapi/v1/premiumIndex"));
/** Spot mid prices for the symbols. */
const spots = (symbols: string[]) => cached(`basis:spot:${symbols.join(",")}`, 5_000, async () => {
  const rows = await getJson<{ symbol: string; bidPrice: string; askPrice: string }[]>(`https://api.binance.com/api/v3/ticker/bookTicker?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  return new Map(rows.map((r) => [r.symbol, (num(r.bidPrice) + num(r.askPrice)) / 2]));
});
/** Last seven days of settled funding (21 settlements) for one symbol. */
const settled = (symbol: string) => cached(`basis:hist:${symbol}`, 60_000, () => getJson<Settled[]>(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=30`));

export async function loadConfig(db: SupabaseClient): Promise<BasisConfig> {
  const r = await db.from("basis_config").select("*").eq("id", 1).single();
  if (r.error) throw new Error(r.error.message);
  const c = r.data as Record<string, unknown>;
  return {
    enabled: !!c.enabled, mode: c.mode as BasisConfig["mode"], symbols: (c.symbols as string[]) ?? [], notional: num(c.notional),
    entry_rate: num(c.entry_rate), exit_rate: num(c.exit_rate), max_open: num(c.max_open), spot_fee: num(c.spot_fee), perp_fee: num(c.perp_fee),
  };
}

const rules = (c: BasisConfig) => ({ entryRate: c.entry_rate, exitRate: c.exit_rate, spotFee: c.spot_fee, perpFee: c.perp_fee });

/** The live funding board for the configured symbols plus any symbol with an open position. */
export async function fundingBoard(cfg: BasisConfig, openSymbols: Set<string>): Promise<BoardRow[]> {
  const symbols = [...new Set([...cfg.symbols, ...openSymbols])];
  if (!symbols.length) return [];
  const [prem, spot, hist] = await Promise.all([premiums(), spots(symbols).catch(() => new Map<string, number>()), Promise.all(symbols.map((s) => settled(s).catch(() => [] as Settled[])))]);
  const bySym = new Map(prem.map((p) => [p.symbol, p]));
  return symbols.flatMap((symbol, k) => {
    const p = bySym.get(symbol);
    if (!p) return [];
    const h = hist[k]!.map((x) => ({ t: x.fundingTime, rate: num(x.fundingRate) })).sort((a, b) => a.t - b.t);
    const rates = h.map((x) => x.rate);
    const predicted = num(p.lastFundingRate), mark = num(p.markPrice), sp = spot.get(symbol) ?? null;
    const f = { predicted, lastSettled: rates.at(-1) ?? null, avg3d: mean(rates.slice(-9)), avg7d: mean(rates.slice(-21)) };
    const open = openSymbols.has(symbol);
    return [{
      symbol, spot: sp, mark, index: num(p.indexPrice), basisPct: sp ? ((mark - sp) / sp) * 100 : null,
      ...f, nextFundingAt: p.nextFundingTime, apr: settlementApr(predicted) * 100, avgApr7d: f.avg7d === null ? null : settlementApr(f.avg7d) * 100,
      breakEven: breakEvenSettlements(predicted, rules(cfg)), history: h.slice(-21), signal: basisSignal(open, f, rules(cfg)), open,
    }];
  });
}

/** Live P&L of a position at the board's prices (closed positions at their exit prices). */
export function positionPnl(p: PositionRow, board: BoardRow[]): BasisPnl & { cost: number } {
  const leg = { qty: num(p.qty), spotEntry: num(p.spot_entry), perpEntry: num(p.perp_entry), spotFee: num(p.spot_fee), perpFee: num(p.perp_fee) };
  const row = board.find((b) => b.symbol === p.symbol);
  const spot = p.status === "closed" ? num(p.spot_exit) : row?.spot ?? leg.spotEntry;
  const perp = p.status === "closed" ? num(p.perp_exit) : row?.mark ?? leg.perpEntry;
  const end = p.closed_at ? Date.parse(p.closed_at) : Date.now();
  return { ...basisPnl({ ...leg, funding: num(p.funding), openedAt: Date.parse(p.opened_at) }, spot, perp, end), cost: roundTripCost(leg) };
}

/** Record the settlements an open position earned (or paid) since it was last accrued. */
async function accrue(db: SupabaseClient, p: PositionRow): Promise<number> {
  const since = Date.parse(p.last_funding_at ?? p.opened_at);
  const due = (await settled(p.symbol)).filter((x) => x.fundingTime > since && x.fundingTime <= Date.now()).sort((a, b) => a.fundingTime - b.fundingTime);
  if (!due.length) return 0;
  const rows = due.map((x) => ({ position_id: p.id, symbol: p.symbol, funding_time: new Date(x.fundingTime).toISOString(), rate: num(x.fundingRate), mark: num(x.markPrice), amount: fundingForShort(num(p.qty), num(x.markPrice), num(x.fundingRate)) }));
  const ins = await db.from("basis_funding").upsert(rows, { onConflict: "position_id,funding_time", ignoreDuplicates: true });
  if (ins.error) throw new Error(ins.error.message);
  const total = rows.reduce((a, r) => a + r.amount, 0);
  await db.from("basis_positions").update({ funding: num(p.funding) + total, funding_count: p.funding_count + rows.length, last_funding_at: rows.at(-1)!.funding_time }).eq("id", p.id).eq("status", "open");
  return rows.length;
}

export async function openPosition(db: SupabaseClient, cfg: BasisConfig, row: BoardRow, source: "auto" | "manual"): Promise<string> {
  if (!row.spot) throw new Error(`no spot price for ${row.symbol}`);
  const qty = cfg.notional / row.spot;
  const fees = qty * (row.spot * cfg.spot_fee + row.mark * cfg.perp_fee);
  const r = await db.from("basis_positions").insert({
    symbol: row.symbol, qty, notional: cfg.notional, spot_entry: row.spot, perp_entry: row.mark, entry_rate: row.predicted, entry_avg3d: row.avg3d,
    fees, spot_fee: cfg.spot_fee, perp_fee: cfg.perp_fee, source,
  }).select("id").single();
  if (r.error) throw new Error(r.error.message);
  return r.data.id as string;
}

export async function closePosition(db: SupabaseClient, p: PositionRow, row: BoardRow | undefined, reason: string): Promise<void> {
  await accrue(db, p).catch(() => 0);
  const fresh = (await db.from("basis_positions").select("*").eq("id", p.id).single()).data as PositionRow;
  const spot = row?.spot ?? num(fresh.spot_entry), perp = row?.mark ?? num(fresh.perp_entry);
  const exitFees = num(fresh.qty) * (spot * num(fresh.spot_fee) + perp * num(fresh.perp_fee));
  const r = await db.from("basis_positions").update({ status: "closed", spot_exit: spot, perp_exit: perp, fees: num(fresh.fees) + exitFees, closed_at: new Date().toISOString(), exit_reason: reason }).eq("id", p.id).eq("status", "open");
  if (r.error) throw new Error(r.error.message);
}

/** One pass: accrue funding, exit on negative funding, enter on positive carry. */
export async function basisTick(db: SupabaseClient): Promise<string> {
  const cfg = await loadConfig(db);
  if (!cfg.enabled || cfg.mode === "off") return "";
  const openRes = await db.from("basis_positions").select("*").eq("status", "open");
  if (openRes.error) throw new Error(openRes.error.message);
  const open = (openRes.data ?? []) as PositionRow[];
  let accrued = 0;
  for (const p of open) accrued += await accrue(db, p);
  const board = await fundingBoard(cfg, new Set(open.map((p) => p.symbol)));
  const notes: string[] = [];
  for (const p of open) {
    const row = board.find((b) => b.symbol === p.symbol);
    if (row?.signal === "exit") {
      await closePosition(db, p, row, row.predicted < cfg.exit_rate ? `predicted funding ${(row.predicted * 100).toFixed(4)}%` : `settled funding ${((row.lastSettled ?? 0) * 100).toFixed(4)}%`);
      notes.push(`closed ${p.symbol}`);
    }
  }
  let openCount = open.length - notes.length;
  for (const row of board.filter((b) => b.signal === "enter" && cfg.symbols.includes(b.symbol)).sort((a, b) => b.predicted - a.predicted)) {
    if (openCount >= cfg.max_open) break;
    await openPosition(db, cfg, row, "auto");
    openCount++;
    notes.push(`opened ${row.symbol} @ ${(row.predicted * 100).toFixed(4)}%`);
  }
  return [accrued ? `${accrued} funding settlement${accrued === 1 ? "" : "s"}` : "", ...notes].filter(Boolean).join(" · ");
}
