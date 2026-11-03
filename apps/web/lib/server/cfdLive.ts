import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CTRADER_SPECS, INSTRUMENTS, TF_MS, toCTraderSymbol, type Candle, type InstrumentId } from "@aplus/engine";
import { ENDED_TTL_MS, judge, lifecycle, type LiveOutcome, type LivePhase } from "@/lib/cfdLive";
import { targets } from "@/lib/propAccounts";
import { cfdExecMode, endCfdAlertNotice, reviseCfdAlert } from "@/lib/server/cfdAlerts";
import { cancelOrders } from "@/lib/server/cfdOrders";
import { evaluate } from "@/lib/server/autopilot";
import { instrumentOk, loadCandles, loadQuote } from "@/lib/server/feeds";
import { loadCalendar } from "@/lib/server/news";
import { chatsFrom, type Chat } from "@/lib/server/telegram";
import { errMsg } from "@/lib/server/http";

/**
 * CFD live board, the server half. Every confirmed CFD alert is marked to the live price on each read:
 * armed → at the entry → in the trade → won or lost, or it ends early as expired, ran away or dead.
 * While a setup waits for its fill the detector re-reads it about once a minute: if the levels moved the
 * alert, its sizes and its cTrader links follow (with a Telegram update), and if the setup broke it is
 * closed out (two reads in a row, so one noisy read cannot kill it). Runs on the dashboard's poll and on
 * every autopilot pass, so nothing goes stale when no one is watching. Every write is guarded by the row's
 * previous state, so overlapping runs cannot double-act.
 */

const DETECTOR_EVERY_MS = 60_000;
const STRIKES_TO_END = 2;

export interface LiveLeg { legId: string; accountId: string; name: string; lots: number; legs: number[]; risk: number; blocked: string | null; link: string | null; action: string | null; pending: number; failed: string | null }
export interface LiveRevision { at: string; from: { entry: number; stop: number; tp1: number; tp2: number }; to: { entry: number; stop: number; tp1: number; tp2: number } }
export interface LiveAlert {
  id: string; instrument: string; symbol: string; side: "long" | "short"; model: string | null; grade: string | null; digits: number;
  entry: number; stop: number; tp1: number; tp2: number; rr: number;
  createdAt: string; expiresAt: string; levelsAt: string; checkedAt: string | null;
  phase: LivePhase; outcome: LiveOutcome | null; endedReason: string | null; endedAt: string | null; filledAt: string | null;
  tp1Hit: boolean; r: number | null; toEntryR: number | null; price: number | null; priceSource: string | null;
  status: string; why: string[]; revisions: LiveRevision[]; legs: LiveLeg[]; strikes: number;
}
export interface Forming {
  instrument: string; symbol: string; side: "long" | "short"; state: string; grade: string | null; at: string; digits: number;
  waitingFor: string[]; blockers: string[]; plan: { entry: number; stop: number; target: number } | null; price: number | null;
}
export interface LiveBoard { at: number; alerts: LiveAlert[]; forming: Forming[]; notes: string[]; execMode: "off" | "confirm" }

type Row = {
  id: string; signal_id: string | null; instrument: string; symbol: string; side: "long" | "short"; model: string | null; grade: string | null;
  entry: number; stop: number; tp1: number; tp2: number; expires_at: string; created_at: string; status: string; why: string[];
  phase: LivePhase; outcome: LiveOutcome | null; ended_reason: string | null; filled_at: string | null; ended_at: string | null; result_r: number | null;
  levels_at: string | null; revisions: LiveRevision[] | null; checked_at: string | null; strikes: number;
  cfd_alert_legs: { id: string; account_id: string; lots: number; legs: number[]; risk_amount: number; blocked: string | null; link: string | null; action: string | null; trading_accounts: { name: string } | null }[];
};

const n = (x: unknown) => Number(x);
const OUTCOME_TEXT: Record<LiveOutcome, string> = {
  win: "TP2 reached", partial: "TP1 booked, rest stopped", loss: "stopped out", expired: "no fill before the order expired",
  ran_away: "TP1 reached before the entry filled", dead: "setup broke before a fill",
};

/** Mark every open CFD alert to the market, re-check unfilled ones with the detector, and return the board. */
export async function syncCfdLive(db: SupabaseClient, opts: { detector?: boolean; now?: number } = {}): Promise<LiveBoard> {
  const now = opts.now ?? Date.now();
  const notes: string[] = [];
  const res = await db.from("cfd_alerts")
    .select("*, cfd_alert_legs(id, account_id, lots, legs, risk_amount, blocked, link, action, trading_accounts(name))")
    .or(`phase.neq.ended,ended_at.gte.${new Date(now - ENDED_TTL_MS).toISOString()}`)
    .order("created_at", { ascending: false }).limit(40);
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data ?? []) as Row[];

  // One candle pull and one quote per market with an open alert (both cached in the feed layer).
  const open = rows.filter((r) => r.phase !== "ended");
  const ids = [...new Set(open.map((r) => r.instrument).filter(instrumentOk))] as InstrumentId[];
  const market = new Map<string, { candles: Candle[]; price: number | null; source: string | null }>();
  await Promise.all(ids.map(async (id) => {
    const [c, q] = await Promise.all([
      loadCandles(id, INSTRUMENTS[id].ltf, 300).catch(() => null),
      loadQuote(id).catch(() => null),
    ]);
    const candles = c ? [...c.candles, ...(c.forming ? [c.forming] : [])] : [];
    market.set(id, { candles, price: q?.last ?? candles.at(-1)?.c ?? null, source: q?.source ?? c?.source ?? null });
  }));

  // cTrader orders already sent for these alerts, and whether Place is on.
  const ordRes = rows.length ? await db.from("cfd_orders").select("alert_id, leg_id, status, error").in("alert_id", rows.map((r) => r.id)).order("created_at") : { data: [] };
  const orders = (ordRes.data ?? []) as (OrderRow & { alert_id: string })[];
  const execMode = await cfdExecMode(db);

  // Settings, chats and calendar only when there is something to re-check or announce.
  let ctx: Awaited<ReturnType<typeof context>> | null = null;
  const getCtx = async () => (ctx ??= await context(db));

  const out: LiveAlert[] = [];
  for (const r of rows) {
    const levels = { side: r.side, entry: n(r.entry), stop: n(r.stop), tp1: n(r.tp1), tp2: n(r.tp2) };
    const m = market.get(r.instrument);
    let row = r;
    let life = r.phase === "ended" || !m || !instrumentOk(r.instrument)
      ? null
      : lifecycle(levels, { levelsAt: Date.parse(r.levels_at ?? r.created_at), expiresAt: Date.parse(r.expires_at), filledAt: r.filled_at ? Date.parse(r.filled_at) : null }, m.candles, TF_MS[INSTRUMENTS[r.instrument as InstrumentId].ltf], m.price, now);

    // Re-read unfilled setups with the detector (about once a minute per alert).
    if (life && opts.detector !== false && (life.phase === "armed" || life.phase === "trigger") && (!r.checked_at || now - Date.parse(r.checked_at) >= DETECTOR_EVERY_MS)) {
      try {
        const c = await getCtx();
        const e = await evaluate(r.instrument as InstrumentId, { bias: r.side, calendar: c.calendar, settings: c.settings ?? undefined });
        const p = e.side === r.side ? e.analysis.suggest : null;
        const v = judge({ state: e.side === r.side ? e.state : "IDLE", blockers: [...(e.gate?.blockers ?? []), ...(e.newsClear ? [] : ["inside a high-impact news window"])], ranAway: e.side === r.side && !!e.analysis.after?.ranAway, plan: p ? { entry: p.entry, stop: p.stop, target: p.target } : null }, levels, r.side);
        const stamp = new Date(now).toISOString();
        if (v.kind === "keep") {
          await db.from("cfd_alerts").update({ checked_at: stamp, strikes: 0 }).eq("id", r.id).eq("phase", r.phase);
          row = { ...row, checked_at: stamp, strikes: 0 };
        } else if (v.kind === "revise") {
          const tp = targets({ side: r.side, ...v.plan });
          const to = { entry: v.plan.entry, stop: v.plan.stop, tp1: tp.tp1, tp2: tp.tp2 };
          const from = { entry: levels.entry, stop: levels.stop, tp1: levels.tp1, tp2: levels.tp2 };
          const revisions = [...(r.revisions ?? []), { at: stamp, from, to }].slice(-10);
          const upd = await db.from("cfd_alerts").update({ ...to, levels_at: stamp, checked_at: stamp, strikes: 0, revisions, phase: "armed" })
            .eq("id", r.id).eq("levels_at", r.levels_at ?? r.created_at).select("id");
          if (!upd.error && upd.data?.length) {
            const acting = r.status === "armed" || r.status === "taken";
            // Orders sent at the old levels are cancelled; the update carries Place for the new ones.
            const cancelled = await cancelOrders(db, { alertId: r.id }, "levels moved").catch(() => 0);
            await reviseCfdAlert(db, c.chats, r.id, { instrument: r.instrument, side: r.side, entry: to.entry, stop: to.stop, target: to.tp2, expiresAt: Date.parse(r.expires_at), signalId: r.signal_id }, from, acting && c.chats.length > 0, cancelled).catch(() => undefined);
            notes.push(`${r.symbol} levels moved`);
            row = { ...row, ...to, levels_at: stamp, checked_at: stamp, strikes: 0, revisions };
            life = lifecycle({ side: r.side, ...to }, { levelsAt: now, expiresAt: Date.parse(r.expires_at) }, m!.candles, TF_MS[INSTRUMENTS[r.instrument as InstrumentId].ltf], m!.price, now);
          }
        } else {
          const strikes = r.strikes + 1;
          if (strikes >= STRIKES_TO_END) {
            life = { ...life, phase: "ended", outcome: v.kind, endedAt: now, r: null, toEntryR: null };
            row = { ...row, ended_reason: v.reason };
          } else {
            await db.from("cfd_alerts").update({ checked_at: stamp, strikes }).eq("id", r.id).eq("phase", r.phase);
            row = { ...row, checked_at: stamp, strikes };
          }
        }
      } catch (e) {
        notes.push(`${r.symbol} detector: ${errMsg(e)}`);
      }
    }

    // Persist phase changes; announce early ends of alerts someone may have an order on.
    if (life && (life.phase !== r.phase || life.outcome !== r.outcome || (life.filledAt !== null && !r.filled_at))) {
      const ended = life.phase === "ended";
      const reason = ended ? row.ended_reason ?? OUTCOME_TEXT[life.outcome!] : null;
      const patch: Record<string, unknown> = {
        phase: life.phase, outcome: life.outcome, filled_at: life.filledAt ? new Date(life.filledAt).toISOString() : null,
        ...(ended ? { ended_at: new Date(life.endedAt ?? now).toISOString(), ended_reason: reason, result_r: life.r } : {}),
        ...(ended && !life.filledAt && r.status === "armed" ? { status: "expired" } : {}),
      };
      const upd = await db.from("cfd_alerts").update(patch).eq("id", r.id).eq("phase", r.phase).select("id");
      if (!upd.error && upd.data?.length) {
        row = { ...row, ...(patch as Partial<Row>) };
        if (ended && !life.filledAt) {
          // Pending cTrader orders placed from this alert are cancelled once it ends without a fill.
          const n = await cancelOrders(db, { alertId: r.id }, `setup ${life.outcome}`).catch(() => 0);
          if (n) notes.push(`${r.symbol}: ${n} cTrader order${n === 1 ? "" : "s"} cancelled`);
        }
        if (ended && !life.filledAt && (life.outcome === "dead" || life.outcome === "ran_away" || r.status === "taken")) {
          const c = await getCtx();
          if (c.chats.length) await endCfdAlertNotice(db, c.chats, { id: r.id, symbol: r.symbol, side: r.side, signalId: r.signal_id }, life.outcome!, reason!).catch(() => undefined);
        }
        if (ended) notes.push(`${r.symbol} ${life.outcome}`);
      }
    }
    out.push(view(row, life, m ?? null, orders.filter((o) => o.alert_id === r.id)));
  }

  return { at: now, alerts: out, forming: await forming(db, out, now).catch(() => []), notes, execMode };
}

async function context(db: SupabaseClient) {
  const [s, cal] = await Promise.all([
    db.from("app_settings").select("integrations, counter_trend_allowed, advanced_models_allowed, news_block_minutes").eq("id", 1).maybeSingle(),
    loadCalendar().catch(() => ({ items: [] })),
  ]);
  const settings = s.data as { integrations?: { telegram_chats?: Chat[] }; counter_trend_allowed?: boolean; advanced_models_allowed?: boolean; news_block_minutes?: number } | null;
  return { settings, chats: chatsFrom(settings?.integrations?.telegram_chats), calendar: cal.items };
}

type OrderRow = { leg_id: string | null; status: string; error: string | null };

function view(r: Row, life: ReturnType<typeof lifecycle> | null, m: { price: number | null; source: string | null } | null, orders: OrderRow[] = []): LiveAlert {
  const entry = n(r.entry), stop = n(r.stop), tp2 = n(r.tp2), risk = Math.abs(entry - stop);
  return {
    id: r.id, instrument: r.instrument, symbol: r.symbol, side: r.side, model: r.model, grade: r.grade, digits: CTRADER_SPECS[r.symbol]?.digits ?? 2,
    entry, stop, tp1: n(r.tp1), tp2, rr: risk ? Math.round((Math.abs(tp2 - entry) / risk) * 100) / 100 : 0,
    createdAt: r.created_at, expiresAt: r.expires_at, levelsAt: r.levels_at ?? r.created_at, checkedAt: r.checked_at,
    phase: life?.phase ?? r.phase, outcome: life?.outcome ?? r.outcome, endedReason: r.ended_reason, endedAt: r.ended_at,
    filledAt: life?.filledAt ? new Date(life.filledAt).toISOString() : r.filled_at,
    tp1Hit: life?.tp1Hit ?? (r.outcome === "win" || r.outcome === "partial"), r: life ? life.r : r.result_r === null ? null : n(r.result_r), toEntryR: life?.toEntryR ?? null,
    price: r.phase === "ended" ? null : m?.price ?? null, priceSource: m?.source ?? null,
    status: r.status, why: r.why ?? [], revisions: r.revisions ?? [], strikes: r.strikes,
    legs: (r.cfd_alert_legs ?? []).map((l) => ({
      legId: l.id, pending: orders.filter((o) => o.leg_id === l.id && o.status === "pending").length,
      failed: orders.filter((o) => o.leg_id === l.id && o.status === "failed").at(-1)?.error ?? null,
      accountId: l.account_id, name: l.trading_accounts?.name ?? "Account", lots: n(l.lots), legs: (l.legs ?? []).map(n), risk: n(l.risk_amount), blocked: l.blocked, link: l.link, action: l.action })),
  };
}

/** Setups still forming on CFD markets (from the autopilot's latest state per market), without an open alert. */
async function forming(db: SupabaseClient, alerts: LiveAlert[], now: number): Promise<Forming[]> {
  const cfg = await db.from("autopilot_config").select("instrument, mode").neq("mode", "off");
  const ids = ((cfg.data ?? []) as { instrument: string }[]).map((c) => c.instrument).filter((i) => toCTraderSymbol(i) && instrumentOk(i));
  if (!ids.length) return [];
  const busy = new Set(alerts.filter((a) => a.phase !== "ended").map((a) => `${a.instrument}:${a.side}`));
  const rows = await Promise.all(ids.map((id) => db.from("autopilot_runs").select("instrument, side, state, grade, at, detail").eq("instrument", id).order("at", { ascending: false }).limit(1).maybeSingle()));
  const live = rows.map((x) => x.data as { instrument: string; side: "long" | "short" | null; state: string; grade: string | null; at: string; detail: { waitingFor?: string[]; blockers?: string[]; suggest?: { entry: number; stop: number; target: number } | null } } | null)
    .filter((x): x is NonNullable<typeof x> => !!x && !!x.side && ["IN_POI", "SWEPT", "SHIFTED", "ARMED"].includes(x.state) && now - Date.parse(x.at) < 3 * 3_600_000 && !busy.has(`${x.instrument}:${x.side}`));
  const prices = await Promise.all(live.map((x) => loadQuote(x.instrument as InstrumentId).then((q) => q.last).catch(() => null)));
  const ORDER = ["ARMED", "SHIFTED", "SWEPT", "IN_POI"];
  return live.map((x, i) => {
    const symbol = toCTraderSymbol(x.instrument)!;
    const s = x.detail?.suggest;
    return {
      instrument: x.instrument, symbol, side: x.side!, state: x.state, grade: x.grade, at: x.at, digits: CTRADER_SPECS[symbol]?.digits ?? 2,
      waitingFor: x.detail?.waitingFor ?? [], blockers: x.detail?.blockers ?? [], plan: s ? { entry: s.entry, stop: s.stop, target: s.target } : null, price: prices[i] ?? null,
    };
  }).sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
}
