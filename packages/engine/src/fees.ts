import { round } from './num.js';

/**
 * Performance fee with a high-water mark.
 * fee = rate × max(0, NAV_end − HWM − netDeposits).
 * When profit above the HWM is paid out, NAV resets to the HWM; otherwise the
 * HWM stays and a loss must be recovered before any new fee.
 */
export function hwmFee(p: { navEnd: number; hwm: number; rate: number; netDeposits?: number }) {
  if (p.rate < 0 || p.rate > 1) throw new Error('rate must be in [0, 1]');
  const above = Math.max(0, p.navEnd - p.hwm - (p.netDeposits ?? 0));
  const fee = round(above * p.rate, 2);
  const toInvestor = round(above - fee, 2);
  return { above: round(above, 2), fee, toInvestor, newHwm: Math.max(p.hwm, p.navEnd) };
}

/** Run a monthly sequence where profit above HWM is withdrawn each month. */
export function hwmSchedule(start: number, monthEnds: readonly number[], rate: number) {
  let hwm = start, nav = start;
  return monthEnds.map((end) => {
    const r = hwmFee({ navEnd: end, hwm, rate });
    const row = { start: nav, end, hwm, ...r };
    nav = r.above > 0 ? hwm : end;
    return row;
  });
}

/** Prop payout split: firm keeps (1 − firmSplit); we take `ourRate` of what the firm pays. */
export function propPayout(p: { profit: number; firmSplit: number; ourRate: number }) {
  if (p.profit < 0) throw new Error('profit must be ≥ 0');
  const firmPays = round(p.profit * p.firmSplit, 2);
  const commission = round(firmPays * p.ourRate, 2);
  return { firmPays, firmKeeps: round(p.profit - firmPays, 2), commission, toInvestor: round(firmPays - commission, 2) };
}

/** Subscription MRR: quarterly price counts as price ÷ 3 per month. */
export function mrr(plans: readonly { price: number; months: number; active: number }[]): number {
  return round(plans.reduce((a, p) => a + (p.price / p.months) * p.active, 0), 2);
}

/** Churn over a period: churned ÷ (active at start + new). */
export function churnRate(startActive: number, newMembers: number, churned: number): number {
  const base = startActive + newMembers;
  return base > 0 ? churned / base : 0;
}
