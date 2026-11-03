import type { Candle } from "@aplus/engine";
import { targets } from "@/lib/propAccounts";

/**
 * CFD live board, the pure half: where a confirmed CFD alert is in its life, from candles and the
 * latest price. Server code feeds it; tests pin the rules.
 *
 *   armed     limit entry waiting, price away from it
 *   trigger   price is at the entry (within TRIGGER_R of the risk): place / expect the fill now
 *   in_trade  entry traded; live R against stop, TP1 and TP2
 *   ended     win (TP2), partial (TP1 then stop), loss (stop), expired (no fill in time),
 *             ran_away (TP1 reached without a fill) or dead (the setup broke before a fill)
 */

export type LivePhase = "armed" | "trigger" | "in_trade" | "ended";
export type LiveOutcome = "win" | "partial" | "loss" | "expired" | "ran_away" | "dead";

export interface AlertLevels { side: "long" | "short"; entry: number; stop: number; tp1: number; tp2: number }
export interface AlertTimes { levelsAt: number; expiresAt: number; filledAt?: number | null }

export interface Lifecycle {
  phase: LivePhase;
  outcome: LiveOutcome | null;
  filledAt: number | null;
  endedAt: number | null;
  tp1Hit: boolean;
  /** R now: open R in a trade, the booked R when ended in a trade, null otherwise. */
  r: number | null;
  /** Distance from price to the entry in R (positive = price still has to come to the entry). */
  toEntryR: number | null;
}

/** Price within this share of the risk from the entry counts as "at the entry". */
export const TRIGGER_R = 0.25;
/** Ended setups stay on the board this long. */
export const ENDED_TTL_MS = 6 * 3_600_000;

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** R of a trade split in two equal legs: half at TP1, the rest at TP2 or the stop. */
export function splitR(l: AlertLevels, exit: "tp2" | "tp1_stop" | "stop"): number {
  const risk = Math.abs(l.entry - l.stop);
  if (!risk) return 0;
  const r1 = Math.abs(l.tp1 - l.entry) / risk, r2 = Math.abs(l.tp2 - l.entry) / risk;
  return round(exit === "tp2" ? (r1 + r2) / 2 : exit === "tp1_stop" ? (r1 - 1) / 2 : -1);
}

/**
 * Walk the entry-TF candles after the current levels were set, then the live price, and say where the
 * alert stands. A bar that touches both the entry and the stop counts as a fill and a loss (worst case).
 */
export function lifecycle(l: AlertLevels, t: AlertTimes, candles: readonly Candle[], tfMs: number, price: number | null, now: number): Lifecycle {
  const long = l.side === "long";
  const risk = Math.abs(l.entry - l.stop);
  const reached = (lo: number, hi: number, level: number, below: boolean) => (below ? lo <= level : hi >= level);
  // Bars that closed after the levels were set, plus the live price as a zero-width bar.
  const bars = candles.filter((c) => c.t + tfMs > t.levelsAt).map((c) => ({ t: Math.max(c.t, t.levelsAt), lo: c.l, hi: c.h }));
  if (price !== null) bars.push({ t: now, lo: price, hi: price });

  let filledAt = t.filledAt ?? null;
  let tp1Hit = false;
  for (const b of bars) {
    if (filledAt === null) {
      if (b.t > t.expiresAt) return ended("expired", t.expiresAt);
      if (reached(b.lo, b.hi, l.entry, long)) {
        filledAt = b.t;
        if (reached(b.lo, b.hi, l.stop, long)) return ended("loss", b.t, splitR(l, "stop"));
        continue;
      }
      if (reached(b.lo, b.hi, l.tp1, !long)) return ended("ran_away", b.t);
      continue;
    }
    if (b.t < filledAt) continue;
    // The stop is checked first: a bar that reaches both counts the worse way.
    if (reached(b.lo, b.hi, l.stop, long)) return tp1Hit ? ended("partial", b.t, splitR(l, "tp1_stop")) : ended("loss", b.t, splitR(l, "stop"));
    if (reached(b.lo, b.hi, l.tp2, !long)) return ended("win", b.t, splitR(l, "tp2"));
    if (reached(b.lo, b.hi, l.tp1, !long)) tp1Hit = true;
  }
  if (filledAt === null && now > t.expiresAt) return ended("expired", t.expiresAt);

  const toEntryR = price !== null && risk ? round(((long ? price - l.entry : l.entry - price) / risk), 2) : null;
  if (filledAt !== null) {
    const openR = price !== null && risk ? (long ? price - l.entry : l.entry - price) / risk : null;
    // After TP1 half the position is booked; the rest runs.
    const r1 = risk ? Math.abs(l.tp1 - l.entry) / risk : 0;
    const r = openR === null ? null : round(tp1Hit ? (r1 + openR) / 2 : openR);
    return { phase: "in_trade", outcome: null, filledAt, endedAt: null, tp1Hit, r, toEntryR };
  }
  const phase: LivePhase = toEntryR !== null && toEntryR <= TRIGGER_R ? "trigger" : "armed";
  return { phase, outcome: null, filledAt: null, endedAt: null, tp1Hit: false, r: null, toEntryR };

  function ended(outcome: LiveOutcome, at: number, r: number | null = null): Lifecycle {
    return { phase: "ended", outcome, filledAt, endedAt: at, tp1Hit: tp1Hit || outcome === "win" || outcome === "partial", r, toEntryR: null };
  }
}

/** Whether new levels differ enough from the old to be worth an update (a tenth of the risk on any level). */
export function levelsChanged(a: Omit<AlertLevels, "side">, b: Omit<AlertLevels, "side">): boolean {
  const tol = Math.abs(a.entry - a.stop) * 0.1;
  return (["entry", "stop", "tp1", "tp2"] as const).some((k) => Math.abs(a[k] - b[k]) > tol);
}

/** What the detector says about an unfilled alert's setup, read for the alert's own side. */
export interface DetectorRead { state: string; blockers: string[]; ranAway: boolean; plan: { entry: number; stop: number; target: number } | null }
export type Verdict = { kind: "keep" } | { kind: "revise"; plan: { entry: number; stop: number; target: number } } | { kind: "ran_away"; reason: string } | { kind: "dead"; reason: string };

/**
 * Keep, move the levels, or end an unfilled alert from a fresh detector read:
 * - still armed with different levels → revise
 * - shifted (armed but the gate is momentarily not GO, e.g. between checks) → keep
 * - the sweep or the shift is gone, or a hard blocker (news, daily cap) appeared → dead
 * - the detector saw price leave without a pullback → ran away
 */
export function judge(read: DetectorRead, current: Omit<AlertLevels, "side">, side: "long" | "short"): Verdict {
  if (read.ranAway) return { kind: "ran_away", reason: "price left without a pullback" };
  const hard = read.blockers.find((b) => /news|cap|limit|kill|weekend/i.test(b));
  if (hard) return { kind: "dead", reason: hard };
  if (read.state === "ARMED" && read.plan) {
    const p = read.plan;
    const okSide = side === "long" ? p.stop < p.entry && p.target > p.entry : p.stop > p.entry && p.target < p.entry;
    if (!okSide) return { kind: "keep" };
    const tp1 = targets({ side, ...p }).tp1;
    return levelsChanged(current, { entry: p.entry, stop: p.stop, tp1, tp2: p.target }) ? { kind: "revise", plan: p } : { kind: "keep" };
  }
  if (read.state === "SHIFTED") return { kind: "keep" };
  return { kind: "dead", reason: read.state === "SWEPT" ? "the 5M shift failed" : "the sweep and shift are gone" };
}
