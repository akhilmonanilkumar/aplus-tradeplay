import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { modelName, strategyName, venueKey, type InstrumentId } from "@aplus/engine";
import { DELTA_SYMBOL, planLiveOrder, policyFrom, type LivePolicy, type ProductSpec } from "@/lib/liveRisk";
import { cached } from "@/lib/server/http";
import { deltaKeysAvailable, deltaPrivate, deltaPublic, type DeltaEnv, type DeltaProduct, type DeltaTicker } from "@/lib/server/delta";
import { loadQuote } from "@/lib/server/feeds";
import type { CalEvent } from "@/lib/server/news";

/**
 * The one door for real-money orders. Each autopilot pass:
 *  1. sync the venue: equity, positions, working and finished orders → live_orders, journal closed trades;
 *  2. enforce account stops: kill switch cancels working entries, API failures halt for a while;
 *  3. for each new signal of a promoted strategy with execution on, that maps to a Delta product, run
 *     the risk gate and place a limit entry with its stop-loss and take-profit attached (bracket).
 * Mode `dry-run` plans and records orders without sending anything; `testnet` trades the demo account;
 * `production` needs DELTA_ENV=production in Vercel as well.
 */

type Mode = "off" | "dry-run" | "testnet" | "production";
interface State {
  mode: Mode; policy: unknown; halted_until: string | null; halt_reason: string | null; peak_equity: number | null; day_date: string | null;
  day_start_equity: number | null; dry_run_equity: number; api_errors: number[]; leverage_set: Record<string, number>; account_id: string | null;
}
interface LiveOrder {
  id: string; created_at: string; signal_id: string | null; candidate_key: string; mode: Mode; symbol: string; product_id: number | null; side: "buy" | "sell";
  contracts: number; limit_price: number | null; stop: number | null; target: number | null; risk_usd: number | null; client_order_id: string; exchange_order_id: string | null;
  status: string; fill_price: number | null; filled_at: string | null; pnl: number | null; meta: Record<string, unknown>;
}
type VenueOrder = { id: number; client_order_id?: string | null; state: string; size: number; unfilled_size: number; average_fill_price?: string | null; product_id: number; side: string; reduce_only?: boolean; updated_at?: string; created_at?: string; paid_commission?: string };
type VenuePosition = { product_id: number; product_symbol?: string; size: number; entry_price?: string };

const istDay = (t: number) => new Date(t + 330 * 60_000).toISOString().slice(0, 10);
const venueEnv = (mode: Mode): DeltaEnv => (mode === "production" ? "production" : "testnet");

/** Product specs by symbol for an environment (testnet and production ids differ). */
const products = (env: DeltaEnv) => cached(`delta:products:${env}`, 3_600_000, async () => {
  const rows = await deltaPublic<DeltaProduct[]>("/v2/products", { contract_types: "perpetual_futures", states: "live" }, env);
  return new Map(rows.map((p) => [p.symbol, { symbol: p.symbol, productId: p.id, contractValue: Number(p.contract_value), tick: Number(p.tick_size), takerFee: Number(p.taker_commission_rate ?? 0.0005) } satisfies ProductSpec]));
});
const tickerMid = async (symbol: string, env: DeltaEnv) => {
  const t = await deltaPublic<DeltaTicker>(`/v2/tickers/${symbol}`, {}, env);
  const bid = Number(t.quotes?.best_bid), ask = Number(t.quotes?.best_ask);
  return bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(t.mark_price);
};

async function loadState(db: SupabaseClient): Promise<State> {
  const r = await db.from("live_exec_state").select("*").eq("id", 1).single();
  if (r.error) throw new Error(r.error.message);
  const s = r.data as Record<string, unknown>;
  return {
    mode: (s.mode as Mode) ?? "off", policy: s.policy, halted_until: (s.halted_until as string) ?? null, halt_reason: (s.halt_reason as string) ?? null,
    peak_equity: s.peak_equity === null ? null : Number(s.peak_equity), day_date: (s.day_date as string) ?? null, day_start_equity: s.day_start_equity === null ? null : Number(s.day_start_equity),
    dry_run_equity: Number(s.dry_run_equity ?? 1000), api_errors: ((s.api_errors as number[]) ?? []).map(Number), leverage_set: (s.leverage_set as Record<string, number>) ?? {}, account_id: (s.account_id as string) ?? null,
  };
}

/** Record an API failure; enough of them in the window halts live trading for a while. */
async function apiFailure(db: SupabaseClient, st: State, policy: LivePolicy, err: string) {
  const now = Date.now();
  const recent = [...st.api_errors.filter((t) => now - t < policy.apiErrorWindowMin * 60_000), now];
  const halt = recent.length >= policy.apiErrorLimit;
  await db.from("live_exec_state").update({
    api_errors: recent, last_error: err.slice(0, 500), updated_at: new Date().toISOString(),
    ...(halt ? { halted_until: new Date(now + policy.haltMinutes * 60_000).toISOString(), halt_reason: `${recent.length} API errors in ${policy.apiErrorWindowMin} min: ${err.slice(0, 200)}` } : {}),
  }).eq("id", 1);
  st.api_errors = recent;
  if (halt) st.halted_until = new Date(now + policy.haltMinutes * 60_000).toISOString();
}

/** The trading account row live trades are journaled to (created on first use). */
async function ensureAccount(db: SupabaseClient, st: State, mode: Mode, equity: number): Promise<string> {
  if (st.account_id) {
    await db.from("trading_accounts").update({ balance: equity, equity }).eq("id", st.account_id);
    return st.account_id;
  }
  const r = await db.from("trading_accounts").insert({
    name: mode === "production" ? "Delta live" : "Delta testnet", type: mode === "production" ? "master" : "demo", venue: "delta", platform: "Delta Exchange India",
    currency: "USD", start_balance: equity, balance: equity, equity, hwm: equity, risk_pct: policyFrom(st.policy).riskPct, is_live: mode === "production", active: true,
    notes: "Orders placed automatically by promoted strategies through the live risk gate.",
  }).select("id").single();
  if (r.error) throw new Error(r.error.message);
  await db.from("live_exec_state").update({ account_id: r.data.id }).eq("id", 1);
  st.account_id = r.data.id as string;
  return st.account_id;
}

/** Sync working and finished orders and positions with the venue; journal closed trades. */
async function reconcile(db: SupabaseClient, st: State, policy: LivePolicy, env: DeltaEnv, specs: Map<string, ProductSpec>, killSwitch: boolean): Promise<string[]> {
  const notes: string[] = [];
  const mine = await db.from("live_orders").select("*").in("status", ["submitted", "open", "filled"]).neq("mode", "dry-run");
  const rows = (mine.data ?? []) as LiveOrder[];
  if (!rows.length) return notes;
  const [open, history, positions] = await Promise.all([
    deltaPrivate<VenueOrder[]>("GET", "/v2/orders", { query: { states: "open,pending" }, env }),
    deltaPrivate<VenueOrder[]>("GET", "/v2/orders/history", { query: { page_size: 100 }, env }),
    deltaPrivate<VenuePosition[]>("GET", "/v2/positions/margined", { env }),
  ]);
  const byId = new Map([...history, ...open].map((o) => [String(o.id), o]));
  const posBy = new Map(positions.map((p) => [p.product_id, p]));
  for (const o of rows) {
    const v = o.exchange_order_id ? byId.get(o.exchange_order_id) : undefined;
    const spec = specs.get(o.symbol);
    const now = new Date().toISOString();
    if (o.status === "submitted" || o.status === "open") {
      const filled = v && Number(v.size) - Number(v.unfilled_size) > 0 && (v.state === "closed" || Number(v.unfilled_size) === 0);
      if (filled) {
        await db.from("live_orders").update({ status: "filled", fill_price: Number(v!.average_fill_price ?? o.limit_price), filled_at: v!.updated_at ?? now, updated_at: now, meta: { ...o.meta, venue: v } }).eq("id", o.id);
        notes.push(`${o.symbol} filled`);
      } else if (v && v.state === "cancelled") {
        await db.from("live_orders").update({ status: "cancelled", updated_at: now }).eq("id", o.id);
      } else if (v && (killSwitch || Date.now() - Date.parse(o.created_at) > policy.cancelAfterMin * 60_000)) {
        await deltaPrivate("DELETE", "/v2/orders", { body: { id: Number(o.exchange_order_id), product_id: o.product_id }, env });
        await db.from("live_orders").update({ status: "cancelled", reasons: [killSwitch ? "kill switch" : `unfilled after ${policy.cancelAfterMin} min`], updated_at: now }).eq("id", o.id);
        notes.push(`${o.symbol} entry cancelled`);
      } else if (v && o.status === "submitted") {
        await db.from("live_orders").update({ status: "open", updated_at: now }).eq("id", o.id);
      }
      continue;
    }
    // Filled: closed once the venue shows no position in the product.
    const pos = o.product_id ? posBy.get(o.product_id) : undefined;
    if (pos && Number(pos.size) !== 0) continue;
    const fill = Number(o.fill_price ?? o.limit_price);
    const exitOrder = history.filter((h) => h.product_id === o.product_id && String(h.id) !== o.exchange_order_id && h.state === "closed" && Number(h.average_fill_price) > 0 && Date.parse(h.updated_at ?? h.created_at ?? now) >= Date.parse(o.filled_at ?? o.created_at))
      .sort((a, b) => Date.parse(b.updated_at ?? b.created_at ?? now) - Date.parse(a.updated_at ?? a.created_at ?? now))[0];
    const exit = exitOrder ? Number(exitOrder.average_fill_price) : null;
    if (exit === null || !spec) continue;
    const dir = o.side === "buy" ? 1 : -1;
    const fees = spec.takerFee * spec.contractValue * o.contracts * (fill + exit);
    const pnl = dir * (exit - fill) * o.contracts * spec.contractValue - fees;
    const riskUsd = Number(o.risk_usd ?? 0);
    const accountId = st.account_id;
    let tradeId: string | null = null;
    if (accountId) {
      const sig = o.signal_id ? (await db.from("signals").select("instrument, model, session_window, grade").eq("id", o.signal_id).maybeSingle()).data : null;
      const t = await db.from("trades").insert({
        account_id: accountId, signal_id: o.signal_id, instrument: sig?.instrument ?? o.symbol, side: dir > 0 ? "long" : "short", model: sig?.model ?? null, session_window: sig?.session_window ?? null,
        qty: o.contracts * spec.contractValue, entry: fill, exit, stop: o.stop, target: o.target, planned_r: null, realized_r: riskUsd > 0 ? Number((pnl / riskUsd).toFixed(3)) : null,
        pnl: Number(pnl.toFixed(2)), fees: Number(fees.toFixed(4)), opened_at: o.filled_at ?? o.created_at, closed_at: now, source: "live", grade: sig?.grade === "A" ? "A" : "A+", risk_pct: policy.riskPct,
      }).select("id").single();
      tradeId = (t.data?.id as string) ?? null;
    }
    await db.from("live_orders").update({ status: "closed", exit_price: exit, closed_at: now, pnl: Number(pnl.toFixed(2)), fees: Number(fees.toFixed(4)), trade_id: tradeId, updated_at: now }).eq("id", o.id);
    notes.push(`${o.symbol} closed ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
  }
  return notes;
}

/** One live-execution pass. Returns a one-line summary for the tick log. */
export async function liveExecTick(db: SupabaseClient, ctx: { killSwitch: boolean; calendar: CalEvent[]; newsBlocked: (events: CalEvent[], instrument: InstrumentId, now: number, minutes: number) => boolean }): Promise<string> {
  const st = await loadState(db);
  if (st.mode === "off") return "";
  const policy = policyFrom(st.policy);
  const now = Date.now();
  const env = venueEnv(st.mode);
  const sending = st.mode === "testnet" || st.mode === "production";
  if (st.mode === "production" && process.env.DELTA_ENV !== "production") return "production mode needs DELTA_ENV=production in Vercel: nothing sent";
  if (sending && !deltaKeysAvailable(env)) return `${st.mode}: Delta ${env} keys are not set: nothing sent`;
  const notes: string[] = [];
  const specs = await products(sending ? env : "production");

  // 1) Venue sync: equity, positions, orders.
  let equity = st.dry_run_equity;
  if (sending) {
    try {
      const bal = await deltaPrivate<{ asset_symbol: string; balance: string; available_balance?: string }[]>("GET", "/v2/wallet/balances", { env });
      equity = Number(bal.find((b) => b.asset_symbol === "USD" || b.asset_symbol === "USDT")?.balance ?? 0);
      notes.push(...await reconcile(db, st, policy, env, specs, ctx.killSwitch));
      await db.from("live_exec_state").update({ last_sync_at: new Date().toISOString() }).eq("id", 1);
    } catch (e) {
      await apiFailure(db, st, policy, (e as Error).message);
      return `${st.mode}: venue sync failed: ${(e as Error).message}`;
    }
    await ensureAccount(db, st, st.mode, equity).catch(() => null);
  }
  const today = istDay(now);
  const peak = Math.max(st.peak_equity ?? equity, equity);
  const dayStart = st.day_date === today && st.day_start_equity ? st.day_start_equity : equity;
  await db.from("live_exec_state").update({ peak_equity: peak, day_date: today, day_start_equity: dayStart, updated_at: new Date().toISOString() }).eq("id", 1);

  // 2) New signals of promoted strategies with execution on.
  // Delta strategies the League has promoted (venue-scoped keys: delta/<instrument>:<model>).
  const live = await db.from("strategy_candidates").select("key, live_since, execute").eq("venue", "delta").in("stage", ["live_small", "live"]).eq("execute", true);
  const since = new Map(((live.data ?? []) as { key: string; live_since: string | null }[]).map((c) => [c.key, Date.parse(c.live_since ?? "1970-01-01")]));
  if (!since.size) return [st.mode, `equity $${equity.toFixed(2)}`, "no live strategies with execution on", ...notes].join(" · ");
  const sigs = await db.from("signals").select("id, instrument, side, model, entry, stop, target, meta, created_at").gte("created_at", new Date(now - policy.signalTtlMin * 60_000 * 3).toISOString()).order("created_at");
  const candidates = ((sigs.data ?? []) as { id: string; instrument: string; side: "long" | "short"; model: string | null; entry: number; stop: number; target: number | null; meta: { strategy?: string } | null; created_at: string }[])
    .filter((s) => { const k = venueKey("delta", s.instrument, s.model, s.meta?.strategy); const t = since.get(k); return t !== undefined && Date.parse(s.created_at) >= t && DELTA_SYMBOL[s.instrument] && s.target !== null; });
  if (!candidates.length) return [st.mode, `equity $${equity.toFixed(2)}`, ...notes].join(" · ");

  const existing = await db.from("live_orders").select("client_order_id, symbol, status, risk_usd, pnl, closed_at, created_at").gte("created_at", new Date(now - 3 * 86_400_000).toISOString());
  const ex = (existing.data ?? []) as { client_order_id: string; symbol: string; status: string; risk_usd: number | null; pnl: number | null; closed_at: string | null; created_at: string }[];
  const done = new Set(ex.map((x) => x.client_order_id));
  for (const s of candidates) {
    const clientId = s.id.replace(/-/g, "");
    if (done.has(clientId)) continue;
    const symbol = DELTA_SYMBOL[s.instrument]!;
    const spec = specs.get(symbol);
    const key = venueKey("delta", s.instrument, s.model, s.meta?.strategy);
    const name = s.model === "S" ? strategyName(s.meta?.strategy) : modelName(s.model);
    const counted = ex.filter((x) => x.status !== "rejected" && x.status !== "cancelled" && x.status !== "error" && istDay(Date.parse(x.created_at)) === today);
    const closedToday = ex.filter((x) => x.status === "closed" && x.closed_at && istDay(Date.parse(x.closed_at)) === today);
    const openRisk = ex.filter((x) => ["submitted", "open", "filled", ...(sending ? [] : ["dry-run"])].includes(x.status) && (sending || istDay(Date.parse(x.created_at)) === today));
    const base = { signal_id: s.id, candidate_key: key, mode: st.mode as Exclude<Mode, "off">, symbol, product_id: spec?.productId ?? null, client_order_id: clientId, meta: { strategy: name, instrument: s.instrument } };
    if (!spec) {
      await db.from("live_orders").insert({ ...base, side: s.side === "long" ? "buy" : "sell", status: "rejected", reasons: [`${symbol} not listed on Delta ${env}`] });
      done.add(clientId);
      continue;
    }
    let ourPrice: number, venueMid: number;
    try {
      ourPrice = (await loadQuote(s.instrument as InstrumentId)).last;
      venueMid = await tickerMid(symbol, sending ? env : "production");
    } catch (e) {
      notes.push(`${symbol}: no price (${(e as Error).message})`);
      continue;
    }
    const r = planLiveOrder({
      policy, now, equity, startOfDayEquity: dayStart, peakEquity: peak,
      todayPnl: closedToday.reduce((a, x) => a + Number(x.pnl ?? 0), 0), todayLosses: closedToday.filter((x) => Number(x.pnl) < 0).length, todayTrades: counted.length,
      open: openRisk.map((x) => ({ symbol: x.symbol, riskUsd: Number(x.risk_usd ?? 0) })),
      killSwitch: ctx.killSwitch, haltedUntil: st.halted_until ? Date.parse(st.halted_until) : null,
      newsBlocked: ctx.newsBlocked(ctx.calendar, s.instrument as InstrumentId, now, policy.newsBlockMin),
      signal: { createdAt: Date.parse(s.created_at), side: s.side, entry: Number(s.entry), stop: Number(s.stop), target: Number(s.target) },
      ourPrice, venueMid, product: spec,
    });
    const planRow = r.plan ? { side: r.plan.side, contracts: r.plan.contracts, limit_price: r.plan.limitPrice, stop: r.plan.stop, target: r.plan.target, risk_usd: r.plan.riskUsd, rr: r.plan.rr, basis: r.plan.basis } : { side: s.side === "long" ? "buy" : "sell" };
    if (!r.ok) {
      await db.from("live_orders").insert({ ...base, ...planRow, status: "rejected", reasons: r.reasons });
      done.add(clientId);
      notes.push(`${symbol} skipped: ${r.reasons[0]}`);
      continue;
    }
    if (!sending) {
      await db.from("live_orders").insert({ ...base, ...planRow, status: "dry-run", meta: { ...base.meta, plan: r.plan, ourPrice, venueMid } });
      done.add(clientId);
      ex.push({ client_order_id: clientId, symbol, status: "dry-run", risk_usd: r.plan.riskUsd, pnl: null, closed_at: null, created_at: new Date().toISOString() });
      notes.push(`${symbol} planned ${r.plan.side} ${r.plan.contracts} (dry run)`);
      continue;
    }
    // Send: leverage once per product, then the bracketed limit entry.
    try {
      if ((st.leverage_set[symbol] ?? 0) !== policy.maxLeverage) {
        await deltaPrivate("POST", `/v2/products/${spec.productId}/orders/leverage`, { body: { leverage: String(policy.maxLeverage) }, env });
        st.leverage_set[symbol] = policy.maxLeverage;
        await db.from("live_exec_state").update({ leverage_set: st.leverage_set }).eq("id", 1);
      }
      const ins = await db.from("live_orders").insert({ ...base, ...planRow, status: "submitted", meta: { ...base.meta, plan: r.plan, ourPrice, venueMid } }).select("id").single();
      if (ins.error) { notes.push(`${symbol}: ${ins.error.message}`); continue; }
      done.add(clientId);
      const order = await deltaPrivate<VenueOrder>("POST", "/v2/orders", {
        env,
        body: {
          product_id: spec.productId, size: r.plan.contracts, side: r.plan.side, order_type: "limit_order", limit_price: String(r.plan.limitPrice), time_in_force: "gtc",
          client_order_id: clientId, bracket_stop_loss_price: String(r.plan.stop), bracket_take_profit_price: String(r.plan.target), bracket_stop_trigger_method: "mark_price",
        },
      });
      await db.from("live_orders").update({ exchange_order_id: String(order.id), status: order.state === "closed" ? "filled" : "open", fill_price: order.state === "closed" ? Number(order.average_fill_price ?? r.plan.limitPrice) : null, filled_at: order.state === "closed" ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq("id", ins.data.id);
      notes.push(`${symbol} ${r.plan.side} ${r.plan.contracts} @ ${r.plan.limitPrice} sent`);
    } catch (e) {
      const msg = (e as Error).message;
      await db.from("live_orders").update({ status: "error", error: msg.slice(0, 500), updated_at: new Date().toISOString() }).eq("client_order_id", clientId);
      await apiFailure(db, st, policy, msg);
      notes.push(`${symbol} order failed: ${msg}`);
    }
  }
  return [st.mode, `equity $${equity.toFixed(2)}`, ...notes].join(" · ");
}

/** Read-only status for the Live page: keys, wallet, positions, working orders, products. */
export async function liveStatus(db: SupabaseClient) {
  const st = await loadState(db);
  const env = venueEnv(st.mode === "off" || st.mode === "dry-run" ? "testnet" : st.mode);
  const out: Record<string, unknown> = { mode: st.mode, env, deltaEnv: process.env.DELTA_ENV === "production" ? "production" : "testnet", relay: !!process.env.DELTA_RELAY_URL, keys: { testnet: deltaKeysAvailable("testnet"), production: deltaKeysAvailable("production") } };
  try { const p = await products(env); out.products = ["BTCUSD", "XAUTUSD"].map((s) => p.get(s) ?? { symbol: s, missing: true }); } catch (e) { out.productsError = (e as Error).message; }
  if (deltaKeysAvailable(env)) {
    const tryGet = async (path: string, query?: Record<string, string | number>) => { try { return await deltaPrivate("GET", path, { env, query }); } catch (e) { return { error: (e as Error).message }; } };
    out.wallet = await tryGet("/v2/wallet/balances");
    out.positions = await tryGet("/v2/positions/margined");
    out.openOrders = await tryGet("/v2/orders", { states: "open,pending" });
  }
  return out;
}
