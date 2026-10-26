import { rewardToRisk, sideOf } from './sizing.js';
import { premiumDiscount } from './smc.js';
import { ENTRY_MODELS, type ModelId } from './models.js';
import { EDGE_RULES } from './specs.js';

/** `warn` = passes but misses one A+ trigger (soft rule) → grade A at most. */
export type BoxStatus = 'pass' | 'warn' | 'fail' | 'pending';
export type Grade = 'A+' | 'A' | 'FORMING' | 'WATCHING' | 'NO_TRADE';
export type Verdict = 'GO' | 'WAIT' | 'NO';

export interface GateInput {
  htfTrend: 'up' | 'down' | null;
  poiTfTrend: 'up' | 'down' | null;
  side: 'long' | 'short';
  price: number;
  range: { low: number; high: number; midBandPct?: number };
  poi: {
    inside: boolean | null;
    fresh: boolean;
    trendAligned: boolean;
    /** Swept liquidity when it formed, or liquidity resting beside it. */
    liquidityStory: boolean;
    /** The move out of the POI broke structure. Defaults to true. */
    createdBos?: boolean;
  };
  swept: boolean | null;
  shifted: boolean | null;
  timing: {
    inWindow: boolean;
    newsClear: boolean;
    /** Minutes since the last high-impact release (model I). */
    minutesSinceNews?: number | null;
    /** Id of the live window, e.g. 'london_q' (model F). */
    windowId?: string | null;
  };
  plan?: { entry: number; stop: number; target: number; targetIsStructural: boolean; stopIsStructural?: boolean };
  minRR?: number;
  /** e.g. 0.4 for BTCUSDT.P so fees don't eat the 3R. */
  minStopPct?: number;
  /** Quality concern that drops A+ to A (e.g. obstacle in the path to target). */
  qualityConcern?: string | null;
  /** Entry model; defaults to A (market shift). */
  model?: ModelId;
  instrument?: string;
  /** Model-specific confirmations keyed by ModelCheck.id. */
  modelChecks?: Record<string, boolean | null | undefined>;
  /** Automatic no-trade conditions (§5). */
  conditions?: {
    capReached?: string | null;
    emotional?: boolean;
    illiquid?: boolean;
    /** Shift happened but price never pulled back. */
    ranAway?: boolean;
  };
  config?: {
    aggressiveEntryAllowed?: boolean;
    counterTrendAllowed?: boolean;
    advancedModelsAllowed?: boolean;
    postNewsWaitMinutes?: number;
    /** Box 1 needs the 15M to agree with the HTF (default true). False: HTF direction alone. */
    poiAlignRequired?: boolean;
    /** Box 1 needs the trade in the HTF trend direction (default true). False: counter-trend allowed, box 1 always passes. */
    htfTrendRequired?: boolean;
    /** Box 2 premium/discount rule (default true). False: the half is reported, not enforced. */
    halfRequired?: boolean;
  };
}

export interface GateBox {
  n: number;
  id: 'htf_aligned' | 'correct_half' | 'in_quality_poi' | 'liquidity_swept' | 'market_shift' | 'in_window_news_clear' | 'rr_ge_3_real_target';
  label: string;
  status: BoxStatus;
  reason: string;
}

export interface GateResult {
  boxes: GateBox[];
  grade: Grade;
  verdict: Verdict;
  rr: number | null;
  waitingFor: string[];
  /** Hard no-trade reasons outside the boxes (caps, emotion, model not allowed …). */
  blockers: string[];
  /** Soft misses that cap the grade at A. */
  softMisses: string[];
  model: ModelId;
}

const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });

export function evaluateGate(g: GateInput): GateResult {
  const minRR = g.minRR ?? EDGE_RULES.minRR;
  const modelId: ModelId = g.model ?? 'A';
  const model = ENTRY_MODELS[modelId];
  const cfg = {
    aggressive: g.config?.aggressiveEntryAllowed ?? EDGE_RULES.aggressiveEntryAllowed,
    counterTrend: g.config?.counterTrendAllowed ?? EDGE_RULES.counterTrendAllowed,
    advanced: g.config?.advancedModelsAllowed ?? EDGE_RULES.advancedModelsAllowed,
    postNews: g.config?.postNewsWaitMinutes ?? EDGE_RULES.postNewsWaitMinutes,
  };
  const checks = g.modelChecks ?? {};
  const checksFor = (box: number) => model.checks.filter((c) => c.box === box);
  /** Model checks for a box: first failing/pending check wins. */
  const modelGate = (box: number): { status: BoxStatus; reason: string } | null => {
    for (const c of checksFor(box)) {
      const v = checks[c.id];
      if (v === false) return { status: 'fail', reason: `${c.label}: no` };
      if (v !== true) return { status: 'pending', reason: `waiting: ${c.label.toLowerCase()}` };
    }
    return null;
  };

  const want = g.side === 'long' ? 'up' : 'down';
  const boxes: GateBox[] = [];
  const softMisses: string[] = [];
  const blockers: string[] = [];

  // Model availability
  if (model.advanced && !cfg.advanced) blockers.push(`model ${modelId} is advanced-only`);
  if (model.counterTrend && !cfg.counterTrend) blockers.push(`model ${modelId} is counter-trend`);
  if (model.instruments && g.instrument && !model.instruments.includes(g.instrument)) blockers.push(`model ${modelId} is for ${model.instruments.join(', ')}`);
  // Automatic no-trade conditions
  if (g.conditions?.capReached) blockers.push(g.conditions.capReached);
  if (g.conditions?.emotional) blockers.push('emotional — not trading');
  if (g.conditions?.illiquid) blockers.push('volatile / illiquid conditions');
  if (g.conditions?.ranAway) blockers.push('no pullback, no trade');

  // 1 — HTF and POI timeframe aligned with the trade
  {
    let status: BoxStatus, reason: string;
    const alignRequired = g.config?.poiAlignRequired !== false;
    if (g.config?.htfTrendRequired === false) { status = 'pass'; reason = `HTF ${g.htfTrend ?? '—'} · 15M ${g.poiTfTrend ?? '—'} (trend not required)`; }
    else if (!g.htfTrend || (alignRequired && !g.poiTfTrend)) { status = 'pending'; reason = 'structure not established'; }
    else if (g.htfTrend !== g.poiTfTrend && alignRequired) { status = 'pending'; reason = `HTF ${g.htfTrend} vs 15M ${g.poiTfTrend} — wait for alignment`; }
    else if (g.htfTrend !== want) {
      if (model.counterTrend && cfg.counterTrend) { status = 'warn'; reason = `counter-trend ${g.side} (model ${modelId})`; softMisses.push('counter-trend'); }
      else { status = 'fail'; reason = `counter-trend ${g.side}`; }
    }
    else { status = 'pass'; reason = `HTF ${g.htfTrend} · 15M ${g.poiTfTrend ?? '—'}${g.htfTrend !== g.poiTfTrend ? ' (15M not required)' : ''}`; }
    boxes.push({ n: 1, id: 'htf_aligned', label: 'HTF aligned', status, reason });
  }
  // 2 — correct half of the range (mid-range = no trade)
  {
    const ref = g.plan?.entry ?? g.price;
    const pd = premiumDiscount(g.range.low, g.range.high, ref, g.range.midBandPct ?? EDGE_RULES.midBandPct);
    const ok = !pd.outside && ((g.side === 'long' && pd.zone === 'discount') || (g.side === 'short' && pd.zone === 'premium'));
    const reason = pd.outside ? `${fmt(ref)} ${pd.outside} the range — structure breaking` : pd.zone === 'mid' ? `${fmt(ref)} mid-range (EQ ${fmt(pd.eq)})` : `${fmt(ref)} in ${pd.zone} (EQ ${fmt(pd.eq)})`;
    const required = g.config?.halfRequired !== false;
    boxes.push({ n: 2, id: 'correct_half', label: 'Correct half', status: ok || !required ? 'pass' : 'fail', reason: ok || required ? reason : `${reason} (not required)` });
  }
  // 3 — inside a high-probability POI
  {
    let status: BoxStatus = 'pass', reason = 'fresh, trend-aligned, liquidity story';
    if (g.poi.inside === null || g.poi.inside === false) { status = 'pending'; reason = 'price not inside a planned POI'; }
    else if (!g.poi.fresh) { status = 'fail'; reason = 'POI already mitigated'; }
    else if (!g.poi.trendAligned && !(model.counterTrend && cfg.counterTrend)) { status = 'fail'; reason = 'POI against the trend'; }
    else {
      const misses: string[] = [];
      if (!g.poi.liquidityStory) misses.push('no liquidity story');
      if (g.poi.createdBos === false) misses.push('did not break structure');
      if (misses.length > 1) { status = 'fail'; reason = misses.join(' · '); }
      else if (misses.length === 1) { status = 'warn'; reason = misses[0]!; softMisses.push(misses[0]!); }
      const m = modelGate(3);
      if (m && status !== 'fail') { status = m.status; reason = m.reason; }
    }
    boxes.push({ n: 3, id: 'in_quality_poi', label: 'In quality POI', status, reason });
  }
  // 4 — liquidity swept (plus model sweep checks: first tap, Asia range)
  {
    let status: BoxStatus = g.swept ? 'pass' : 'pending';
    let reason = g.swept ? 'wick through, close back' : 'waiting for sweep';
    if (g.swept) { const m = modelGate(4); if (m) { status = m.status; reason = m.reason; } }
    boxes.push({ n: 4, id: 'liquidity_swept', label: 'Liquidity swept', status, reason });
  }
  // 5 — market shift (body close) + model confirmation
  {
    let status: BoxStatus, reason: string;
    if (g.shifted) {
      status = 'pass'; reason = '5M body close through structure';
      const m = modelGate(5); if (m) { status = m.status; reason = m.reason; }
    } else if (model.shift === 'optional_if_aggressive' && cfg.aggressive && g.swept) {
      status = 'warn'; reason = 'aggressive entry on the sweep'; softMisses.push('aggressive entry (no shift)');
    } else { status = 'pending'; reason = 'waiting for 5M body close'; }
    boxes.push({ n: 5, id: 'market_shift', label: 'Market shift', status, reason });
  }
  // 6 — timing: window and news (model I trades the post-news reaction)
  {
    const { inWindow, newsClear } = g.timing;
    let status: BoxStatus, reason: string;
    if (modelId === 'I') {
      const m = g.timing.minutesSinceNews;
      if (m === null || m === undefined) { status = 'pending'; reason = 'no release to trade'; }
      else if (m < cfg.postNews) { status = 'pending'; reason = `${Math.round(m)} min since release — wait ${cfg.postNews}`; }
      else if (!inWindow) { status = 'fail'; reason = 'outside session window'; }
      else { status = 'pass'; reason = `${Math.round(m)} min after release, in window`; }
    } else if (!newsClear) { status = 'fail'; reason = `inside ±${EDGE_RULES.newsBlockMinutes} min news window`; }
    else if (!inWindow) { status = 'fail'; reason = 'outside session window'; }
    else if (model.window && g.timing.windowId && g.timing.windowId !== model.window) { status = 'fail'; reason = `model ${modelId} trades the ${model.window === 'london_q' ? 'London' : 'NY'} window`; }
    else { status = 'pass'; reason = 'in window, news clear'; }
    boxes.push({ n: 6, id: 'in_window_news_clear', label: 'Window & news', status, reason });
  }
  // 7 — R:R to a real target, structural stop, minimum stop distance
  let rr: number | null = null;
  {
    let status: BoxStatus = 'pending', reason = 'no entry / stop / target yet';
    if (g.plan) {
      const s = sideOf(g.plan.entry, g.plan.stop);
      rr = rewardToRisk(g.plan.entry, g.plan.stop, g.plan.target);
      const stopPct = (Math.abs(g.plan.entry - g.plan.stop) / g.plan.entry) * 100;
      if (s !== g.side) { status = 'fail'; reason = 'stop on wrong side of entry'; }
      else if (g.plan.stopIsStructural === false) { status = 'fail'; reason = 'stop is not at an invalidation level'; }
      else if (!g.plan.targetIsStructural) { status = 'fail'; reason = 'target is not a real level'; }
      else if (g.minStopPct !== undefined && stopPct < g.minStopPct) { status = 'fail'; reason = `stop ${stopPct.toFixed(2)}% < ${g.minStopPct}% minimum`; }
      else if (rr < minRR) { status = 'fail'; reason = `R:R ${rr.toFixed(2)} < ${minRR}`; }
      else { status = 'pass'; reason = `R:R ${rr.toFixed(2)} to real target`; }
    }
    boxes.push({ n: 7, id: 'rr_ge_3_real_target', label: 'R:R ≥ 3 real', status, reason });
  }

  if (g.qualityConcern) softMisses.push(g.qualityConcern);
  if (!model.aPlusEligible) softMisses.push(`model ${modelId} is never A+`);

  const anyFail = boxes.some((b) => b.status === 'fail') || blockers.length > 0;
  const allDone = boxes.every((b) => b.status === 'pass' || b.status === 'warn');
  const firstFour = boxes.slice(0, 4).every((b) => b.status === 'pass' || b.status === 'warn');
  const waitingFor = boxes.filter((b) => b.status === 'pending').map((b) => b.reason);

  let grade: Grade, verdict: Verdict;
  if (anyFail) { grade = 'NO_TRADE'; verdict = 'NO'; }
  else if (allDone) {
    if (softMisses.length === 0) { grade = 'A+'; verdict = 'GO'; }
    else if (softMisses.length === 1 || (softMisses.length === 2 && !model.aPlusEligible)) { grade = 'A'; verdict = 'WAIT'; }
    else { grade = 'NO_TRADE'; verdict = 'NO'; blockers.push('misses more than one A+ trigger'); }
  }
  else if (firstFour) { grade = 'FORMING'; verdict = 'WAIT'; }
  else { grade = 'WATCHING'; verdict = 'WAIT'; }

  return { boxes, grade, verdict, rr, waitingFor, blockers, softMisses, model: modelId };
}
