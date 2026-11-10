import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { strategyName, modelName } from "@aplus/engine";
import { fromCTraderSymbol, isSameTrade, matchSetup, type HistRow, type LoggedSetup } from "@/lib/ctraderHistory";

/**
 * Trades taken by hand on a prop account → the journal. Used by the history file upload and by the
 * cTrader API sync: each trade is imported once (by its position id, and by market, side, close time and
 * price against what is already there, so a file and the API never count a trade twice), and linked to
 * the logged setup it was taken from, so the R and the strategy record use that setup's stop.
 */

export interface ImportResult { imported: number; duplicates: number; matched: number; noStop: number; skipped: number; from: number | null; to: number | null }

/** Logged paper setups on these markets in a time range, for matching trades to them. */
export async function loggedSetups(db: SupabaseClient, instruments: string[], from: number, to: number): Promise<LoggedSetup[]> {
  if (!instruments.length) return [];
  const out: LoggedSetup[] = [];
  // Paged: a long history can span thousands of logged setups.
  for (let page = 0; page < 10; page++) {
    const r = await db.from("signals").select("id, instrument, side, model, entry, stop, target, created_at, strategy:meta->>strategy")
      .in("instrument", instruments).in("source", ["autopilot", "selector"])
      .gte("created_at", new Date(from - 8 * 3_600_000).toISOString()).lte("created_at", new Date(to + 60_000).toISOString())
      .order("created_at").range(page * 1000, page * 1000 + 999);
    if (r.error) throw new Error(r.error.message);
    const rows = (r.data ?? []) as { id: string; instrument: string; side: string; model: string | null; entry: number; stop: number; target: number; created_at: string; strategy: string | null }[];
    out.push(...rows.map((s) => ({ id: s.id, instrument: s.instrument, side: s.side, model: s.model, entry: Number(s.entry), stop: Number(s.stop), target: Number(s.target), createdAt: Date.parse(s.created_at), strategy: s.strategy })));
    if (rows.length < 1000) break;
  }
  return out;
}

export const setupLabel = (s: LoggedSetup) => (s.model === "S" ? strategyName(s.strategy) : modelName(s.model ?? "")) || `Model ${s.model}`;

export async function importHistory(db: SupabaseClient, accountId: string, rows: HistRow[]): Promise<ImportResult> {
  const res: ImportResult = { imported: 0, duplicates: 0, matched: 0, noStop: 0, skipped: 0, from: null, to: null };
  const valid = rows.filter((r) => Number.isFinite(r.entry) && Number.isFinite(r.exit) && Number.isFinite(r.closedAt) && Number.isFinite(r.openedAt) && r.entry > 0 && r.exit > 0);
  res.skipped = rows.length - valid.length;
  if (!valid.length) return res;
  const from = Math.min(...valid.map((r) => r.openedAt)), to = Math.max(...valid.map((r) => r.closedAt));
  res.from = from; res.to = to;

  const existing = await db.from("trades").select("external_id, instrument, side, exit, closed_at").eq("account_id", accountId)
    .gte("closed_at", new Date(from - 86_400_000).toISOString()).lte("closed_at", new Date(to + 86_400_000).toISOString()).limit(20000);
  if (existing.error) throw new Error(existing.error.message);
  const have = ((existing.data ?? []) as { external_id: string | null; instrument: string; side: string; exit: number | null; closed_at: string | null }[])
    .filter((t) => t.exit !== null && t.closed_at).map((t) => ({ ext: t.external_id, instrument: t.instrument, side: t.side, exit: Number(t.exit), closedAt: Date.parse(t.closed_at!) }));
  const ids = new Set(have.map((t) => t.ext).filter(Boolean));

  const markets = [...new Set(valid.map((r) => fromCTraderSymbol(r.symbol)))];
  const setups = await loggedSetups(db, markets, from, to);

  const out: Record<string, unknown>[] = [];
  for (const t of valid) {
    const instrument = fromCTraderSymbol(t.symbol);
    const ext = `cth:${t.ref ?? `${instrument}:${t.side}:${t.closedAt}:${t.entry}`}`;
    const probe = { instrument, side: t.side, closedAt: t.closedAt, exit: t.exit };
    if (ids.has(ext) || have.some((h) => isSameTrade(h, probe))) { res.duplicates++; continue; }
    have.push({ ext, ...probe });
    ids.add(ext);
    const s = matchSetup({ instrument, side: t.side, entry: t.entry, openedAt: t.openedAt }, setups);
    if (s) res.matched++;
    const stop = t.sl ?? s?.stop ?? null;
    const risk = stop === null ? 0 : Math.abs(t.entry - stop);
    const r = risk > 0 ? ((t.side === "long" ? 1 : -1) * (t.exit - t.entry)) / risk : null;
    if (r === null) res.noStop++;
    out.push({
      account_id: accountId, external_id: ext, source: "ctrader", instrument, side: t.side, qty: t.qty || 0,
      entry: t.entry, stop: stop ?? t.entry, target: t.tp ?? s?.target ?? null, exit: t.exit, pnl: t.pnl, fees: t.fees,
      realized_r: r === null ? null : Math.round(r * 1000) / 1000, planned_r: s && risk > 0 ? Math.round((Math.abs(s.target - t.entry) / risk) * 1000) / 1000 : null,
      opened_at: new Date(t.openedAt).toISOString(), closed_at: new Date(t.closedAt).toISOString(),
      signal_id: s?.id ?? null, model: s?.model ?? null,
      review: [
        "Imported from the cTrader history file",
        s ? `taken from the ${setupLabel(s)} setup` : "",
        t.sl === null ? (s ? "stop from the setup" : "no stop in the file, R not counted") : "",
        t.comment ?? "",
      ].filter(Boolean).join(" · "),
    });
  }
  for (let i = 0; i < out.length; i += 500) {
    const up = await db.from("trades").upsert(out.slice(i, i + 500), { onConflict: "account_id,external_id", ignoreDuplicates: true }).select("id");
    if (up.error) throw new Error(up.error.message);
    res.imported += up.data?.length ?? 0;
  }
  res.duplicates += out.length - res.imported;
  return res;
}
