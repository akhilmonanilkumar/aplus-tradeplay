import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { venueKey, venuesFor, type InstrumentId } from "@aplus/engine";
import { aiConfigured, complete } from "@/lib/server/ai";
import { notify } from "@/lib/server/notify";
import { evaluateCandidates, leagueRecords } from "@/lib/server/promotion";
import { strategyLab, type Family } from "@/lib/server/strategyLab";

/**
 * The strategy development agent, run daily (pg_cron) or on demand:
 * 1. Backtests a rotating slice of markets × strategy families on a 120-day walk-forward and attaches
 *    the results to the League entries they belong to (session variants and Model A are logged live).
 * 2. Re-runs the League so the new backtests count toward the gates.
 * 3. Reads the standings and the research and proposes new strategies for review (it never deploys code
 *    or changes the gates; proposals wait in the League's ideas list).
 */

const MARKETS: InstrumentId[] = ["XAUUSD", "BTCUSDT.P", "XAUUSDT.P", "EURUSD", "GBPUSD", "USDJPY", "NAS100", "SPX500", "NIFTY"];
const FAMILIES: Family[] = ["session", "a5"];
export const JOBS = MARKETS.flatMap((m) => FAMILIES.map((f) => ({ instrument: m, family: f })));

/** Today's slice of the rotation: every job comes round every few days. */
export function todaysJobs(now = Date.now(), perRun = 4) {
  const day = Math.floor(now / 86_400_000);
  const start = (day * perRun) % JOBS.length;
  return Array.from({ length: Math.min(perRun, JOBS.length) }, (_, i) => JOBS[(start + i) % JOBS.length]!);
}

/** League keys a lab row's result belongs to: session variants by id, the live A+ rules as model A. */
export function keysForRow(instrument: string, family: Family, rowId: string): string[] {
  const model = family === "session" ? "S" : rowId === "live" ? "A" : null;
  if (!model) return [];
  return venuesFor(instrument).map((v) => venueKey(v, instrument, model, model === "S" ? rowId : null));
}

type LabRow = { id: string; label: string; trades: number; pf: number | null; maxDDR: number; avgR: number; netR: number; halves: [number, number]; pass: boolean };
interface Proposal { title: string; market: string; venue: string; idea: string; why: string; test: string }

const PROMPT = `You are the strategy development agent for a private trading desk. You see the Strategy League (paper records per venue and strategy since the restart, with stages) and today's walk-forward backtests.
Write JSON only: {"summary": string (3-5 plain sentences: what is working, what is decaying, where the edge looks strongest by venue and market), "proposals": [{"title","market","venue","idea","why","test"}] (0-3 items)}.
Proposals are new strategy ideas for a human to review, within the desk's edge: liquidity sweeps, session ranges, order flow, open interest, funding, momentum scalps, Nifty/Bank Nifty options. "test" says exactly how to backtest it and what result would justify paper trading. Never propose changing risk limits or gates. Do not invent numbers that are not in the data.`;

export async function runStrategyAgent(db: SupabaseClient, opts: { trigger: string; budgetMs?: number; model?: string | null }) {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 200_000;
  const run = await db.from("strategy_agent_runs").insert({ trigger: opts.trigger }).select("id").single();
  if (run.error) throw new Error(run.error.message);
  const id = run.data.id as string;
  const findings: { instrument: string; family: Family; source?: string; rows?: LabRow[]; error?: string }[] = [];
  try {
    // 1) Backtests for today's slice, inside the time budget.
    for (const job of todaysJobs()) {
      if (Date.now() - t0 > budget * 0.7) { findings.push({ ...job, error: "skipped: time budget" }); continue; }
      try {
        const lab = await strategyLab(job.instrument, job.family, 120);
        const rows = (lab.rows as LabRow[]).map((r) => ({ id: r.id, label: r.label, trades: r.trades, pf: r.pf, maxDDR: r.maxDDR, avgR: r.avgR, netR: r.netR, halves: r.halves, pass: r.pass }));
        findings.push({ ...job, source: lab.source, rows });
        for (const r of rows) {
          for (const key of keysForRow(job.instrument, job.family, r.id)) {
            await db.from("strategy_candidates").update({ backtest: { trades: r.trades, profitFactor: r.pf, maxDrawdownR: r.maxDDR, avgR: r.avgR, halves: r.halves, pass: r.pass, days: 120, at: new Date().toISOString(), source: lab.source } }).eq("key", key);
          }
        }
      } catch (e) {
        findings.push({ ...job, error: (e as Error).message });
      }
    }

    // 2) League pass with the fresh backtests.
    const settings = await db.from("app_settings").select("integrations").eq("id", 1).maybeSingle();
    const integ = settings.data?.integrations as { promotion?: unknown; ai_model?: string } | null;
    const leagueSummary = await evaluateCandidates(db, integ?.promotion);

    // 3) Standings + research → summary and proposals.
    const { rows } = await leagueRecords(db);
    const cands = await db.from("strategy_candidates").select("key, venue, stage, stats, backtest").neq("stage", "retired");
    const standings = (cands.data ?? []).map((c) => {
      const p = (c.stats as { paper?: { n: number; expectancy: number; profitFactor: number | null; maxDrawdownR: number } } | null)?.paper;
      return { key: c.key, stage: c.stage, n: p?.n ?? 0, exp: p?.expectancy ?? 0, pf: p?.profitFactor ?? null, dd: p?.maxDrawdownR ?? 0, bt: c.backtest ? { trades: (c.backtest as { trades: number }).trades, pf: (c.backtest as { profitFactor: number | null }).profitFactor } : null };
    }).sort((a, b) => b.exp * Math.sqrt(b.n) - a.exp * Math.sqrt(a.n));
    const research = findings.map((f) => ({ market: f.instrument, family: f.family, error: f.error, best: f.rows?.filter((r) => r.trades >= 20).sort((a, b) => (b.pf ?? 9) - (a.pf ?? 9)).slice(0, 4) }));

    let summary = `${leagueSummary}. Backtested ${findings.filter((f) => f.rows).length} of ${findings.length} jobs today.`;
    let proposals: Proposal[] = [];
    let model: string | null = null;
    if (aiConfigured().provider && Date.now() - t0 < budget) {
      try {
        const out = await complete({ system: PROMPT, user: JSON.stringify({ standings: standings.slice(0, 40), research, tracked: rows.size }).slice(0, 15000), maxTokens: 900, json: true, model: opts.model ?? integ?.ai_model ?? null });
        model = out.model;
        const j = JSON.parse(out.text.replace(/^```(json)?|```$/g, "").trim()) as { summary?: string; proposals?: Proposal[] };
        if (j.summary) summary = j.summary;
        proposals = (j.proposals ?? []).filter((p) => p?.title && p?.idea).slice(0, 3).map((p) => ({ title: String(p.title).slice(0, 120), market: String(p.market ?? "").slice(0, 40), venue: String(p.venue ?? "").slice(0, 20), idea: String(p.idea).slice(0, 600), why: String(p.why ?? "").slice(0, 400), test: String(p.test ?? "").slice(0, 400) }));
      } catch (e) {
        summary += ` (AI read failed: ${(e as Error).message})`;
      }
    }

    await db.from("strategy_agent_runs").update({ status: "done", summary, findings, proposals, moves: leagueSummary.split(" · ").filter((x) => x.includes("→")), model, ms: Date.now() - t0 }).eq("id", id);
    await notify(db, [{ category: "strategy", severity: "info", title: "Strategy agent ran", body: summary.slice(0, 600), link: "/league", key: `agent:${id}` }]);
    return { id, summary, proposals: proposals.length, ms: Date.now() - t0 };
  } catch (e) {
    await db.from("strategy_agent_runs").update({ status: "failed", error: (e as Error).message, findings, ms: Date.now() - t0 }).eq("id", id);
    throw e;
  }
}
