import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { modelName, stageRiskScale, strategyName, venueKey, type InstrumentId, type Stage } from "@aplus/engine";
import { planLiveOrder, policyFrom } from "@/lib/liveRisk";
import { coinswitchOrder, fyersOrders, venueProduct, type ExecVenue, type VenueMode } from "@/lib/venueExec";
import { engineConfigured, engineFetch } from "@/lib/server/engineHost";
import { loadQuote } from "@/lib/server/feeds";
import type { CalEvent } from "@/lib/server/news";
import { istDay } from "@/lib/derive";

/**
 * CoinSwitch and Fyers execution for strategies the League promotes on those venues. Every signal is run
 * through the same risk gate as Delta and logged with the exact order it would send. In "shadow" mode
 * nothing is sent. "live" stays locked until the first order has been checked by hand against each
 * venue's response (order formats are from their docs, not yet from a live account).
 */

export interface VenueExecConfig { mode: VenueMode; equity?: number; policy?: unknown; liveUnlocked?: boolean }
const DEFAULT_EQUITY: Record<ExecVenue, number> = { coinswitch: 1000, fyers: 100_000 };
const NAME: Record<ExecVenue, string> = { coinswitch: "CoinSwitch", fyers: "Fyers" };

type Sig = { id: string; instrument: string; side: "long" | "short"; model: string | null; entry: number; stop: number; target: number | null; meta: { strategy?: string } | null; created_at: string };

/** Venue price for planning: the engine host's ticker when connected, else our own feed. */
async function venueMid(venue: ExecVenue, symbol: string, ours: number): Promise<{ mid: number; from: string }> {
  if (venue === "coinswitch" && engineConfigured()) {
    try {
      const f = await engineFetch<{ ticker: { last?: number; mark?: number } | null; book: { stats: { mid: number } | null } | null }>("GET", `/flow?venue=coinswitch&symbol=${symbol}&bars=1`);
      const mid = f.book?.stats?.mid ?? f.ticker?.mark ?? f.ticker?.last;
      if (mid) return { mid, from: "CoinSwitch book" };
    } catch { /* fall back */ }
  }
  return { mid: ours, from: venue === "fyers" ? "Nifty index (futures basis applied on send)" : "our feed" };
}

export async function venueExecTick(db: SupabaseClient, ctx: { killSwitch: boolean; calendar: CalEvent[]; newsBlocked: (events: CalEvent[], instrument: InstrumentId, now: number, minutes: number) => boolean }): Promise<string> {
  const s = await db.from("app_settings").select("integrations").eq("id", 1).maybeSingle();
  const cfgs = ((s.data?.integrations as { execution?: Partial<Record<ExecVenue, VenueExecConfig>> } | null)?.execution ?? {});
  const notes: string[] = [];
  const now = Date.now();
  for (const venue of ["coinswitch", "fyers"] as ExecVenue[]) {
    const cfg = cfgs[venue];
    if (!cfg || cfg.mode === "off") continue;
    const policy = policyFrom(cfg.policy);
    const live = await db.from("strategy_candidates").select("key, live_since, stage").eq("venue", venue).in("stage", ["live_small", "live"]).eq("execute", true);
    const keys = new Map(((live.data ?? []) as { key: string; live_since: string | null; stage: Stage }[]).map((c) => [c.key, c]));
    if (!keys.size) { notes.push(`${NAME[venue]}: no live strategies`); continue; }
    const sigs = await db.from("signals").select("id, instrument, side, model, entry, stop, target, meta, created_at").gte("created_at", new Date(now - policy.signalTtlMin * 3 * 60_000).toISOString()).order("created_at");
    const todays = await db.from("live_orders").select("client_order_id, symbol, status, risk_usd, pnl, created_at").eq("venue", venue).gte("created_at", new Date(now - 2 * 86_400_000).toISOString());
    const rows = (todays.data ?? []) as { client_order_id: string; symbol: string; status: string; risk_usd: number | null; pnl: number | null; created_at: string }[];
    const done = new Set(rows.map((r) => r.client_order_id));
    const today = istDay(now);
    const equity = cfg.equity ?? DEFAULT_EQUITY[venue];
    for (const sig of (sigs.data ?? []) as Sig[]) {
      const key = venueKey(venue, sig.instrument, sig.model, sig.meta?.strategy);
      const cand = keys.get(key);
      if (!cand || Date.parse(sig.created_at) < Date.parse(cand.live_since ?? "1970-01-01") || sig.target === null) continue;
      const clientId = `${venue.slice(0, 2)}${sig.id.replace(/-/g, "").slice(0, 30)}`;
      if (done.has(clientId)) continue;
      done.add(clientId);
      const product = venueProduct(venue, sig.instrument, new Date(now));
      const name = sig.model === "S" ? strategyName(sig.meta?.strategy) : modelName(sig.model);
      const base = { venue, signal_id: sig.id, candidate_key: key, mode: "dry-run", client_order_id: clientId, side: sig.side === "long" ? "buy" : "sell" };
      if (!product) {
        await db.from("live_orders").insert({ ...base, symbol: sig.instrument, status: "rejected", reasons: [`${NAME[venue]} has no product mapped for ${sig.instrument}`], meta: { strategy: name } });
        continue;
      }
      let ours: number;
      try { ours = (await loadQuote(sig.instrument as InstrumentId)).last; } catch (e) {
        await db.from("live_orders").insert({ ...base, symbol: product.symbol, status: "error", error: `quote: ${(e as Error).message}`, meta: { strategy: name } });
        continue;
      }
      const vm = await venueMid(venue, product.symbol, ours);
      const counted = rows.filter((x) => !["rejected", "error", "cancelled"].includes(x.status) && istDay(Date.parse(x.created_at)) === today);
      const r = planLiveOrder({
        policy: { ...policy, riskPct: policy.riskPct * stageRiskScale(cand.stage) }, now, equity, startOfDayEquity: equity, peakEquity: equity,
        todayPnl: 0, todayLosses: 0, todayTrades: counted.length, open: [], killSwitch: ctx.killSwitch, haltedUntil: null,
        newsBlocked: ctx.newsBlocked(ctx.calendar, sig.instrument as InstrumentId, now, policy.newsBlockMin),
        signal: { createdAt: Date.parse(sig.created_at), side: sig.side, entry: Number(sig.entry), stop: Number(sig.stop), target: Number(sig.target) },
        ourPrice: ours, venueMid: vm.mid, product,
      });
      const plan = r.plan;
      const payload = plan ? (venue === "coinswitch" ? coinswitchOrder(plan, product, clientId) : fyersOrders(plan, product, `APLUS${clientId.slice(2, 12)}`)) : null;
      const sendNote = cfg.mode === "live" && r.ok ? (cfg.liveUnlocked ? "live sending is not wired yet: logged only" : "live mode is locked until the first order is verified: logged only") : null;
      await db.from("live_orders").insert({
        ...base, symbol: product.symbol, status: r.ok ? "dry-run" : "rejected", reasons: [...r.reasons, ...(sendNote ? [sendNote] : [])],
        contracts: plan ? plan.contracts * product.contractValue : 0, limit_price: plan?.limitPrice ?? null, stop: plan?.stop ?? null, target: plan?.target ?? null,
        risk_usd: plan?.riskUsd ?? null, rr: plan?.rr ?? null, basis: plan?.basis ?? null,
        meta: { strategy: name, instrument: sig.instrument, stage: cand.stage, currency: product.currency, unit: product.unitLabel, priceFrom: vm.from, productNote: product.note ?? null, payload },
      });
      rows.push({ client_order_id: clientId, symbol: product.symbol, status: r.ok ? "dry-run" : "rejected", risk_usd: plan?.riskUsd ?? null, pnl: null, created_at: new Date(now).toISOString() });
      notes.push(`${NAME[venue]} ${product.symbol} ${r.ok ? "planned" : `rejected (${r.reasons[0]})`}`);
    }
  }
  return notes.join(" · ");
}
