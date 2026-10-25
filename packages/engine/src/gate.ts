import { rewardToRisk, sideOf } from './sizing.js';
import { premiumDiscount } from './smc.js';

export type BoxStatus = 'pass' | 'fail' | 'pending';
export type Grade = 'A+' | 'A' | 'FORMING' | 'WATCHING' | 'NO_TRADE';
export type Verdict = 'GO' | 'WAIT' | 'NO';

export interface GateInput {
  htfTrend: 'up' | 'down' | null;
  poiTfTrend: 'up' | 'down' | null;
  side: 'long' | 'short';
  price: number;
  range: { low: number; high: number; midBandPct?: number };
  poi: { inside: boolean | null; fresh: boolean; trendAligned: boolean; liquidityStory: boolean };
  swept: boolean | null;
  shifted: boolean | null;
  timing: { inWindow: boolean; newsClear: boolean };
  plan?: { entry: number; stop: number; target: number; targetIsStructural: boolean };
  minRR?: number;
  /** e.g. 0.4 for BTCUSDT.P so fees don't eat the 3R. */
  minStopPct?: number;
  /** Quality concern that drops A+ to A (e.g. obstacle in the path to target). */
  qualityConcern?: string | null;
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
}

const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });

export function evaluateGate(g: GateInput): GateResult {
  const minRR = g.minRR ?? 3;
  const want = g.side === 'long' ? 'up' : 'down';
  const boxes: GateBox[] = [];

  // 1 — HTF and POI timeframe aligned with the trade
  {
    let status: BoxStatus, reason: string;
    if (!g.htfTrend || !g.poiTfTrend) { status = 'pending'; reason = 'structure not established'; }
    else if (g.htfTrend !== g.poiTfTrend) { status = 'fail'; reason = `HTF ${g.htfTrend} vs 15M ${g.poiTfTrend}`; }
    else if (g.htfTrend !== want) { status = 'fail'; reason = `counter-trend ${g.side}`; }
    else { status = 'pass'; reason = `HTF ${g.htfTrend} · 15M ${g.poiTfTrend}`; }
    boxes.push({ n: 1, id: 'htf_aligned', label: 'HTF aligned', status, reason });
  }
  // 2 — correct half of the range
  {
    const ref = g.plan?.entry ?? g.price;
    const pd = premiumDiscount(g.range.low, g.range.high, ref, g.range.midBandPct ?? 5);
    const ok = (g.side === 'long' && pd.zone === 'discount') || (g.side === 'short' && pd.zone === 'premium');
    boxes.push({ n: 2, id: 'correct_half', label: 'Correct half', status: ok ? 'pass' : 'fail', reason: `${fmt(ref)} in ${pd.zone} (EQ ${fmt(pd.eq)})` });
  }
  // 3 — inside a quality POI
  {
    let status: BoxStatus, reason: string;
    if (g.poi.inside === null || g.poi.inside === false) { status = 'pending'; reason = 'price not inside a planned POI'; }
    else if (!g.poi.fresh) { status = 'fail'; reason = 'POI already mitigated'; }
    else if (!g.poi.trendAligned) { status = 'fail'; reason = 'POI against the trend'; }
    else if (!g.poi.liquidityStory) { status = 'fail'; reason = 'no liquidity story'; }
    else { status = 'pass'; reason = 'fresh, trend-aligned, liquidity story'; }
    boxes.push({ n: 3, id: 'in_quality_poi', label: 'In quality POI', status, reason });
  }
  // 4 — liquidity swept
  boxes.push({ n: 4, id: 'liquidity_swept', label: 'Liquidity swept', status: g.swept ? 'pass' : 'pending', reason: g.swept ? 'wick through, close back' : 'waiting for sweep' });
  // 5 — market shift (body close)
  boxes.push({ n: 5, id: 'market_shift', label: 'Market shift', status: g.shifted ? 'pass' : 'pending', reason: g.shifted ? '5M body close through structure' : 'waiting for 5M body close' });
  // 6 — timing
  {
    const { inWindow, newsClear } = g.timing;
    const status: BoxStatus = !newsClear ? 'fail' : inWindow ? 'pass' : 'fail';
    const reason = !newsClear ? 'inside ±15 min news window' : inWindow ? 'in window, news clear' : 'outside session window';
    boxes.push({ n: 6, id: 'in_window_news_clear', label: 'Window & news', status, reason });
  }
  // 7 — R:R to a real target, plus minimum stop distance
  let rr: number | null = null;
  {
    let status: BoxStatus = 'pending', reason = 'no entry / stop / target yet';
    if (g.plan) {
      const s = sideOf(g.plan.entry, g.plan.stop);
      rr = rewardToRisk(g.plan.entry, g.plan.stop, g.plan.target);
      const stopPct = (Math.abs(g.plan.entry - g.plan.stop) / g.plan.entry) * 100;
      if (s !== g.side) { status = 'fail'; reason = 'stop on wrong side of entry'; }
      else if (!g.plan.targetIsStructural) { status = 'fail'; reason = 'target is not a real level'; }
      else if (g.minStopPct !== undefined && stopPct < g.minStopPct) { status = 'fail'; reason = `stop ${stopPct.toFixed(2)}% < ${g.minStopPct}% minimum`; }
      else if (rr < minRR) { status = 'fail'; reason = `R:R ${rr.toFixed(2)} < ${minRR}`; }
      else { status = 'pass'; reason = `R:R ${rr.toFixed(2)} to real target`; }
    }
    boxes.push({ n: 7, id: 'rr_ge_3_real_target', label: 'R:R ≥ 3 real', status, reason });
  }

  const anyFail = boxes.some((b) => b.status === 'fail');
  const allPass = boxes.every((b) => b.status === 'pass');
  const firstFour = boxes.slice(0, 4).every((b) => b.status === 'pass');
  const waitingFor = boxes.filter((b) => b.status === 'pending').map((b) => b.reason);

  let grade: Grade, verdict: Verdict;
  if (anyFail) { grade = 'NO_TRADE'; verdict = 'NO'; }
  else if (allPass) { grade = g.qualityConcern ? 'A' : 'A+'; verdict = g.qualityConcern ? 'WAIT' : 'GO'; }
  else if (firstFour) { grade = 'FORMING'; verdict = 'WAIT'; }
  else { grade = 'WATCHING'; verdict = 'WAIT'; }

  return { boxes, grade, verdict, rr, waitingFor };
}
