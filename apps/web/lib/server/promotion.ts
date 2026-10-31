import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GATES_V2, INSTRUMENTS, isLiveStage, leaguePass, leagueStats, modelName, paperChecks, parseVenueKey, strategyName, venueKey, venueNetR, venuesFor,
  type Entry, type InstrumentId, type LeagueTrade, type Stage, type Venue,
} from "@aplus/engine";
import { rulesFrom } from "@/lib/promotion";
import { notify } from "@/lib/server/notify";
import { escapeHtml, sendTelegram, type Chat } from "@/lib/server/telegram";

/**
 * Strategy League v2. Paper never stops: every setup the ledger logs is resolved on candles, and each
 * one counts for every venue that could trade its market, with that venue's costs. Each pass re-scores
 * every venue × strategy since the League's restart, applies the gates (engine league.ts), and routes new
 * signals of live strategies to the live chats.
 */

interface Row { key: string; venue: Venue | null; stage: Stage; stage_since: string; pinned: boolean; route_alerts: boolean; live_since: string | null; backtest: { trades: number; profitFactor: number | null; maxDrawdownR?: number | null } | null }
type Sig = { id: string; instrument: string; model: string | null; entry: number; stop: number; meta: { strategy?: string; live_routed?: string } | null; created_at: string; closed_at: string | null; outcome: string | null; net_r: number | null };

/** The legacy status column, kept for the pages and the Delta executor that read it. */
const statusOf = (s: Stage) => (isLiveStage(s) ? "live" : s === "benched" || s === "retired" ? "benched" : "paper");

export async function leagueResetAt(db: SupabaseClient): Promise<number> {
  const s = await db.from("app_settings").select("integrations").eq("id", 1).maybeSingle();
  const at = (s.data?.integrations as { league?: { reset_at?: string } } | null)?.league?.reset_at;
  return at ? Date.parse(at) : 0;
}

/** Every venue × strategy record since the restart. */
export async function leagueRecords(db: SupabaseClient) {
  const resetAt = await leagueResetAt(db);
  const [sigRes, rowRes] = await Promise.all([
    db.from("signals").select("id, instrument, model, entry, stop, meta, created_at, closed_at, outcome, net_r").in("outcome", ["win", "loss"]).gte("created_at", new Date(resetAt).toISOString()).order("closed_at", { ascending: true }).limit(20000),
    db.from("strategy_candidates").select("key, venue, stage, stage_since, pinned, route_alerts, live_since, backtest").neq("stage", "retired"),
  ]);
  if (rowRes.error) throw new Error(rowRes.error.message);
  const rows = new Map(((rowRes.data ?? []) as Row[]).filter((r) => parseVenueKey(r.key)).map((r) => [r.key, r]));
  const trades = new Map<string, LeagueTrade[]>();
  for (const s of (sigRes.data ?? []) as Sig[]) {
    if (s.net_r === null) continue;
    for (const v of venuesFor(s.instrument)) {
      const k = venueKey(v, s.instrument, s.model, s.meta?.strategy);
      trades.set(k, [...(trades.get(k) ?? []), { at: Date.parse(s.closed_at ?? s.created_at), netR: venueNetR(Number(s.net_r), Number(s.entry), Number(s.stop), v) }]);
    }
  }
  return { resetAt, rows, trades };
}

/** Re-score every candidate and apply the League. Returns a one-line summary. */
export async function evaluateCandidates(db: SupabaseClient, rulesRaw: unknown): Promise<string> {
  const r = rulesFrom(rulesRaw);
  const now = Date.now();
  const { rows, trades } = await leagueRecords(db);
  const g = GATES_V2;
  const entries: Entry[] = [...new Set([...trades.keys(), ...rows.keys()])].map((key) => {
    const p = parseVenueKey(key)!;
    const row = rows.get(key);
    const all = trades.get(key) ?? [];
    const liveSince = row?.live_since ? Date.parse(row.live_since) : null;
    return {
      key, venue: p.venue, instrument: p.instrument, stage: row?.stage ?? "paper", pinned: row?.pinned ?? false, stageSince: row ? Date.parse(row.stage_since) : now,
      paper: leagueStats(all), recent: leagueStats(all.slice(-g.demote.lastN)), sinceLive: leagueStats(liveSince && row && isLiveStage(row.stage) ? all.filter((t) => t.at >= liveSince) : []),
      backtest: row?.backtest ?? null,
    };
  });
  const up = await db.from("strategy_candidates").upsert(entries.map((e) => {
    const p = parseVenueKey(e.key)!;
    return {
      key: e.key, venue: e.venue, instrument: e.instrument, model: p.model, strategy: p.strategy, gate_version: g.version, updated_at: new Date(now).toISOString(),
      stats: { paper: e.paper, recent: e.recent, sinceLive: e.sinceLive, checks: paperChecks(e.paper, g, e.backtest) },
      ...(rows.has(e.key) ? {} : { stage: "paper", status: "paper", stage_since: new Date(now).toISOString() }),
    };
  }), { onConflict: "key" });
  if (up.error) throw new Error(up.error.message);
  if (!r.enabled) return `${entries.length} venue strategies scored · League moves off`;

  const moves = leaguePass(entries, g, now).filter((m) => (r.autoPromote || !(m.to === "live_small" || m.to === "live")) && (r.autoDemote || !(isLiveStage(m.from) && m.to === "benched")));
  for (const m of moves) {
    const at = new Date(now).toISOString();
    await db.from("strategy_candidates").update({
      stage: m.to, stage_since: at, status: statusOf(m.to), status_reason: m.reason, updated_at: at,
      ...(m.to === "live_small" ? { live_since: at, benched_at: null } : m.to === "benched" ? { benched_at: at } : {}),
    }).eq("key", m.key);
    await db.from("candidate_events").insert({ key: m.key, from_status: m.from, to_status: m.to, reason: m.reason, stats: entries.find((e) => e.key === m.key)?.paper ?? {} });
  }
  const live = entries.filter((e) => isLiveStage(moves.filter((m) => m.key === e.key).at(-1)?.to ?? e.stage)).length;
  return [`${entries.length} venue strategies`, `${live} live`, ...moves.map((m) => `${m.key} ${m.from}→${m.to}`)].join(" · ");
}

/** New signals of live strategies go to the live chats and the notifications feed, once per signal. */
export async function routeLiveSignals(db: SupabaseClient, chats: Chat[]): Promise<number> {
  const live = await db.from("strategy_candidates").select("key, route_alerts, live_since").in("stage", ["live_small", "live"]);
  const routes = new Map(((live.data ?? []) as { key: string; route_alerts: boolean; live_since: string | null }[]).filter((x) => x.route_alerts).map((x) => [x.key, Date.parse(x.live_since ?? "1970-01-01")]));
  if (!routes.size) return 0;
  const recent = await db.from("signals").select("id, instrument, side, model, entry, stop, target, rr, meta, created_at").gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  let sent = 0;
  for (const s of (recent.data ?? []) as (Sig & { side: string; target: number | null; rr: number | null })[]) {
    if (s.meta?.live_routed) continue;
    const venues = venuesFor(s.instrument).filter((v) => { const t = routes.get(venueKey(v, s.instrument, s.model, s.meta?.strategy)); return t !== undefined && Date.parse(s.created_at) >= t; });
    if (!venues.length) continue;
    const d = INSTRUMENTS[s.instrument as InstrumentId]?.digits ?? 2;
    const name = s.model === "S" ? strategyName(s.meta?.strategy) : modelName(s.model);
    const where = venues.map((v) => ({ cfd: "CFD", delta: "Delta", coinswitch: "CoinSwitch", fyers: "Fyers" })[v]).join(" · ");
    const line = `${s.side === "long" ? "Long" : "Short"} ${Number(s.entry).toFixed(d)} · SL ${Number(s.stop).toFixed(d)}${s.target !== null ? ` · TP ${Number(s.target).toFixed(d)}` : ""}${s.rr ? ` · ${Number(s.rr).toFixed(1)}R` : ""}`;
    if (chats.length) await sendTelegram(db, { text: `🔴 <b>LIVE · ${escapeHtml(s.instrument)} ${escapeHtml(name)}</b>\n${escapeHtml(line)}\nLive on ${escapeHtml(where)} · promoted by the Strategy League`, chats, kind: "LIVE", instrument: s.instrument, signalId: s.id, source: "autopilot" });
    await notify(db, [{ category: "strategy", severity: "success", title: `LIVE signal: ${s.instrument} ${name}`, body: `${line} · ${where}`, instrument: s.instrument, link: "/league", key: `live-sig:${s.id}`, meta: { signal_id: s.id, venues } }]);
    await db.from("signals").update({ meta: { ...(s.meta ?? {}), live_routed: new Date().toISOString() } }).eq("id", s.id);
    sent++;
  }
  return sent;
}
