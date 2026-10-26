/**
 * Opportunity selector: score every live setup across the desks, then pick the best
 * trade per underlying (gold, BTC) so the firm never doubles the same exposure.
 *
 * The score is 0–100 and only ranks setups that already pass the A+ gate; it never
 * turns a failing setup into a trade.
 *   quality 40   A+ (all seven boxes) or A (one soft miss)
 *   reward  15   R:R from 2R (0) to 5R (full)
 *   context 20   confluence score −100…+100 mapped linearly (0 = neutral = 10 pts)
 *   edge    15   recent walk-forward expectancy on this instrument, shrunk to neutral on few trades
 *   timing  10   London/NY killzone 10, another allowed window 5
 *   penalty      4 per caution flag (crowded funding, heavy top-trader positioning), max 12
 */
import type { Grade, Verdict } from './gate.js';
import { INSTRUMENTS, type DeskId, type InstrumentId } from './instruments.js';

export interface Candidate {
  instrument: InstrumentId;
  side: 'long' | 'short';
  /** Detector state (IDLE … ARMED). */
  state: string;
  grade: Grade | null;
  verdict: Verdict | null;
  blockers: readonly string[];
  rr: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  price: number;
  /** Active session window id, if any. */
  window: string | null;
  /** Confluence score for this side, −100…+100. */
  context: number | null;
  caution: readonly string[];
  /** Recent walk-forward result on this instrument. */
  edge: { avgR: number; n: number; winRate: number } | null;
  /** The gate's own first reason (blocker, failed box or what it waits for), shown when not tradeable. */
  gateReason?: string | null;
}

export interface SelectorParams {
  minScore: number;
  allowGradeA: boolean;
  /** Reject when confluence is at or below this (strongly against). */
  minContext: number;
  /** Reject when recent expectancy is below this, once there are enough trades to trust it. */
  minEdgeR: number;
  minEdgeTrades: number;
}

export const DEFAULT_SELECTOR: SelectorParams = { minScore: 60, allowGradeA: false, minContext: -40, minEdgeR: -0.25, minEdgeTrades: 8 };

export interface ScoreParts { quality: number; reward: number; context: number; edge: number; timing: number; penalty: number }

export interface Scored extends Candidate {
  desk: DeskId;
  score: number;
  parts: ScoreParts;
  /** Passes the gate and every selector filter. */
  eligible: boolean;
  /** Why it is not eligible (or why it was passed over). */
  reasons: string[];
}

const KILLZONES = new Set(['london_q', 'ny_q']);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round1 = (x: number) => Math.round(x * 10) / 10;

export function scoreCandidate(c: Candidate, p: SelectorParams = DEFAULT_SELECTOR): Scored {
  const reasons: string[] = [];
  const gradeA = c.grade === 'A' && c.blockers.length === 0;
  const tradeable = c.verdict === 'GO' || (p.allowGradeA && gradeA);
  const hasPlan = [c.entry, c.stop, c.target].every((x) => x !== null && Number.isFinite(x)) && c.entry !== c.stop;

  const quality = c.verdict === 'GO' ? 40 : gradeA ? 28 : 0;
  const reward = c.rr !== null ? clamp01((c.rr - 2) / 3) * 15 : 0;
  const context = c.context !== null ? ((Math.max(-100, Math.min(100, c.context)) + 100) / 200) * 20 : 10;
  let edge = 7.5;
  if (c.edge) {
    const conf = clamp01(c.edge.n / Math.max(1, p.minEdgeTrades));
    edge = conf * clamp01((c.edge.avgR + 0.5) / 1.5) * 15 + (1 - conf) * 7.5;
  }
  const timing = c.window ? (KILLZONES.has(c.window) ? 10 : 5) : 0;
  const penalty = Math.min(12, c.caution.length * 4);
  const parts: ScoreParts = { quality, reward: round1(reward), context: round1(context), edge: round1(edge), timing, penalty };
  const score = Math.round(Math.max(0, quality + reward + context + edge + timing - penalty));

  if (!tradeable) reasons.push(c.grade === 'A' && !p.allowGradeA && c.blockers.length === 0 ? 'grade A (A+ only)' : `${c.verdict === 'NO' ? 'no trade' : `not armed (${c.state.toLowerCase()})`}${c.gateReason ? `: ${c.gateReason}` : ''}`);
  else if (!hasPlan) reasons.push('no entry/stop/target');
  if (c.context !== null && c.context <= p.minContext) reasons.push(`context against (${c.context})`);
  if (c.edge && c.edge.n >= p.minEdgeTrades && c.edge.avgR < p.minEdgeR) reasons.push(`recent edge negative (${c.edge.avgR.toFixed(2)}R over ${c.edge.n})`);
  if (tradeable && hasPlan && score < p.minScore) reasons.push(`score ${score} < ${p.minScore}`);

  return { ...c, desk: INSTRUMENTS[c.instrument].desk, score, parts, eligible: reasons.length === 0, reasons };
}

export interface Selection {
  /** Best eligible setup per free desk, highest score first, at most `slots`. */
  picks: Scored[];
  /** Every candidate, eligible first, then by score. */
  ranked: Scored[];
}

/**
 * Pick at most one trade per desk. `busyDesks` are desks already in a trade or cooling down;
 * `slots` is what is left of the daily budget.
 */
export function selectOpportunities(candidates: readonly Candidate[], opts: { params?: SelectorParams; busyDesks?: ReadonlySet<DeskId>; slots?: number } = {}): Selection {
  const p = opts.params ?? DEFAULT_SELECTOR;
  const busy = opts.busyDesks ?? new Set<DeskId>();
  let slots = opts.slots ?? Infinity;
  const ranked = candidates.map((c) => scoreCandidate(c, p)).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
  const taken = new Set<DeskId>();
  const picks: Scored[] = [];
  for (const s of ranked) {
    if (!s.eligible) continue;
    if (busy.has(s.desk)) { s.reasons.push(`${s.desk} desk busy`); s.eligible = false; continue; }
    if (taken.has(s.desk)) { s.reasons.push(`lower score than the ${s.desk} pick`); s.eligible = false; continue; }
    if (slots <= 0) { s.reasons.push('daily limit reached'); s.eligible = false; continue; }
    picks.push(s);
    taken.add(s.desk);
    slots--;
  }
  return { picks, ranked };
}
