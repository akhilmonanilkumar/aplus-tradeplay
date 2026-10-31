import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INSTRUMENTS, modelName, strategyName, type InstrumentId } from "@aplus/engine";
import { candidateKey, demotionReason, promotable, rulesFrom, statsOf, type CandidateStats, type ResolvedTrade } from "@/lib/promotion";
import { notify } from "@/lib/server/notify";
import { escapeHtml, sendTelegram, type Chat } from "@/lib/server/telegram";

/**
 * Paper never stops: every setup the ledger logs is resolved on candles, so each candidate (market ×
 * entry model, or session strategy) keeps a running record. Each pass this module re-scores the
 * candidates on their recent window, promotes the ones that clear the rules into the live set, benches
 * live ones whose record decays, swaps a clearly better waiting candidate in for the weakest live one,
 * and routes new signals of live strategies to the live alert chats.
 */

interface Row { key: string; status: "paper" | "live" | "benched"; pinned: boolean; route_alerts: boolean; live_since: string | null; benched_at: string | null; stats: { window?: CandidateStats } }
type Sig = { id: string; instrument: string; model: string | null; meta: { strategy?: string; live_routed?: string } | null; created_at: string; closed_at: string | null; outcome: string | null; result_r: number | null; net_r: number | null };

const DAY = 86_400_000;
const resolved = (s: Sig): ResolvedTrade | null =>
  (s.outcome === "win" || s.outcome === "loss") && s.net_r !== null ? { at: Date.parse(s.closed_at ?? s.created_at), netR: Number(s.net_r), grossR: Number(s.result_r ?? s.net_r) } : null;
const split = (key: string) => { const [instrument, model, strategy] = key.split(":"); return { instrument: instrument!, model: model!, strategy: strategy ?? null }; };

async function transition(db: SupabaseClient, key: string, from: string, to: "paper" | "live" | "benched", reason: string, stats: unknown) {
  const now = new Date().toISOString();
  await db.from("strategy_candidates").update({
    status: to, status_reason: reason, updated_at: now,
    ...(to === "live" ? { live_since: now, benched_at: null } : to === "benched" ? { benched_at: now } : {}),
  }).eq("key", key);
  await db.from("candidate_events").insert({ key, from_status: from, to_status: to, reason, stats });
}

/** Re-score every candidate and apply the promotion rules. Returns a one-line summary. */
export async function evaluateCandidates(db: SupabaseClient, rulesRaw: unknown): Promise<string> {
  const r = rulesFrom(rulesRaw);
  const now = Date.now();
  const [sigRes, rowRes] = await Promise.all([
    db.from("signals").select("id, instrument, model, meta, created_at, closed_at, outcome, result_r, net_r").in("outcome", ["win", "loss"]).order("closed_at", { ascending: true }).limit(20000),
    db.from("strategy_candidates").select("key, status, pinned, route_alerts, live_since, benched_at, stats"),
  ]);
  if (rowRes.error) throw new Error(rowRes.error.message);
  const rows = new Map(((rowRes.data ?? []) as Row[]).map((x) => [x.key, x]));
  const byKey = new Map<string, ResolvedTrade[]>();
  for (const s of (sigRes.data ?? []) as Sig[]) {
    const t = resolved(s);
    if (!t) continue;
    const k = candidateKey(s.instrument, s.model, s.meta?.strategy);
    byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }

  // Fresh stats for every candidate seen so far.
  const scored = [...new Set([...byKey.keys(), ...rows.keys()])].map((key) => {
    const all = byKey.get(key) ?? [];
    const row = rows.get(key);
    const window = statsOf(all.filter((t) => t.at >= now - r.windowDays * DAY));
    const recent = statsOf(all.slice(-r.demoteLastN));
    const liveSince = row?.live_since ? Date.parse(row.live_since) : null;
    const live = statsOf(liveSince ? all.filter((t) => t.at >= liveSince) : []);
    return { key, row, stats: { window, recent, live, allTime: statsOf(all), ready: promotable(window, r) } };
  });
  const up = await db.from("strategy_candidates").upsert(scored.map((c) => ({ key: c.key, ...split(c.key), stats: c.stats, updated_at: new Date(now).toISOString() })), { onConflict: "key" });
  if (up.error) throw new Error(up.error.message);
  if (!r.enabled) return `${scored.length} candidates scored · promotion off`;

  const notes: string[] = [];
  const status = (c: (typeof scored)[number]) => c.row?.status ?? "paper";

  // 1) Bench live strategies that broke a demotion rule (pinned ones stay).
  if (r.autoDemote) {
    for (const c of scored.filter((x) => status(x) === "live" && !x.row?.pinned)) {
      const why = demotionReason(c.stats.recent, c.stats.live, r);
      if (why) { await transition(db, c.key, "live", "benched", why, c.stats); notes.push(`benched ${c.key}`); if (c.row) c.row.status = "benched"; }
    }
  }

  // 2) Fill free slots with the best ready candidates; benched ones only after the cool-down.
  const eligible = scored.filter((c) => {
    if (!c.stats.ready || c.row?.pinned) return false;
    if (status(c) === "paper") return true;
    return status(c) === "benched" && (!c.row?.benched_at || now - Date.parse(c.row.benched_at) >= r.cooldownDays * DAY);
  }).sort((a, b) => b.stats.window.score - a.stats.window.score);
  let liveCount = scored.filter((c) => status(c) === "live").length;
  if (r.autoPromote) {
    while (liveCount < r.maxLive && eligible.length) {
      const c = eligible.shift()!;
      await transition(db, c.key, status(c), "live", `window ${c.stats.window.n} trades · ${c.stats.window.expectancy}R/trade · PF ${c.stats.window.profitFactor ?? "∞"} · DD ${c.stats.window.maxDrawdownR}R`, c.stats);
      notes.push(`promoted ${c.key}`);
      liveCount++;
    }
    // 3) Full: swap the weakest unpinned live strategy for a clearly better ready one (one swap per pass).
    const best = eligible[0];
    const weakest = scored.filter((c) => status(c) === "live" && !c.row?.pinned).sort((a, b) => a.stats.window.score - b.stats.window.score)[0];
    if (best && weakest && liveCount >= r.maxLive && best.stats.window.score > Math.max(0, weakest.stats.window.score) * r.swapMargin && best.stats.window.expectancy > weakest.stats.window.expectancy) {
      await transition(db, weakest.key, "live", "benched", `replaced by ${best.key} (score ${best.stats.window.score} vs ${weakest.stats.window.score})`, weakest.stats);
      await transition(db, best.key, status(best), "live", `replaced ${weakest.key} · ${best.stats.window.expectancy}R/trade over ${best.stats.window.n} trades`, best.stats);
      notes.push(`swapped ${weakest.key} → ${best.key}`);
    }
  }
  const ready = scored.filter((c) => c.stats.ready && status(c) !== "live").length;
  return [`${scored.length} candidates`, `${liveCount} live`, ready ? `${ready} ready` : "", ...notes].filter(Boolean).join(" · ");
}

/**
 * New signals of live strategies (logged since they went live, not yet routed) go to the live alert
 * chats and the notifications feed, once each.
 */
export async function routeLiveSignals(db: SupabaseClient, chats: Chat[]): Promise<number> {
  const live = await db.from("strategy_candidates").select("key, route_alerts, live_since").eq("status", "live");
  const routes = new Map(((live.data ?? []) as { key: string; route_alerts: boolean; live_since: string | null }[]).filter((x) => x.route_alerts).map((x) => [x.key, Date.parse(x.live_since ?? "1970-01-01")]));
  if (!routes.size) return 0;
  const recent = await db.from("signals").select("id, instrument, side, model, entry, stop, target, rr, meta, created_at").gte("created_at", new Date(Date.now() - 30 * 60_000).toISOString());
  let sent = 0;
  for (const s of (recent.data ?? []) as (Sig & { side: string; entry: number; stop: number; target: number | null; rr: number | null })[]) {
    const key = candidateKey(s.instrument, s.model, s.meta?.strategy);
    const since = routes.get(key);
    if (since === undefined || Date.parse(s.created_at) < since || s.meta?.live_routed) continue;
    const d = INSTRUMENTS[s.instrument as InstrumentId]?.digits ?? 2;
    const name = s.model === "S" ? strategyName(s.meta?.strategy) : modelName(s.model);
    const line = `${s.side === "long" ? "Long" : "Short"} ${Number(s.entry).toFixed(d)} · SL ${Number(s.stop).toFixed(d)}${s.target !== null ? ` · TP ${Number(s.target).toFixed(d)}` : ""}${s.rr ? ` · ${Number(s.rr).toFixed(1)}R` : ""}`;
    if (chats.length) await sendTelegram(db, { text: `🔴 <b>LIVE · ${escapeHtml(s.instrument)} ${escapeHtml(name)}</b>\n${escapeHtml(line)}\nStrategy ${escapeHtml(key)} · promoted on its paper record`, chats, kind: "LIVE", instrument: s.instrument, signalId: s.id, source: "autopilot" });
    await notify(db, [{ category: "strategy", severity: "success", title: `LIVE signal: ${s.instrument} ${name}`, body: line, instrument: s.instrument, link: "/league", key: `live-sig:${s.id}`, meta: { signal_id: s.id, key } }]);
    await db.from("signals").update({ meta: { ...(s.meta ?? {}), live_routed: new Date().toISOString() } }).eq("id", s.id);
    sent++;
  }
  return sent;
}
