/**
 * Funding basis trade (cash-and-carry): long spot and short the perpetual in equal size. Price moves
 * cancel; while funding is positive the longs pay the shorts, so the short leg collects funding at each
 * settlement. Close when funding turns negative. All amounts in quote currency (USDT).
 *
 * R for a hedged position is the round-trip cost: what it takes to open and close both legs. A position
 * at +3R has earned three times what it cost to put on and take off.
 */

export interface BasisRules {
  /** Enter when the predicted rate per settlement is at least this (0.0001 = 0.01%). */
  entryRate: number;
  /** Exit when a settled or predicted rate falls below this. */
  exitRate: number;
  spotFee: number;
  perpFee: number;
}

export interface BasisLeg { qty: number; spotEntry: number; perpEntry: number; spotFee: number; perpFee: number }

/** Funding a short of `qty` receives at one settlement (negative = pays). */
export const fundingForShort = (qty: number, mark: number, rate: number) => qty * mark * rate;

/** Round-trip trading cost of both legs at the entry prices: 1R. */
export const roundTripCost = (p: BasisLeg) => 2 * p.qty * (p.spotEntry * p.spotFee + p.perpEntry * p.perpFee);

export interface BasisPnl {
  spot: number;
  perp: number;
  /** Basis P&L: spot leg + perp leg (the change in perp − spot spread). */
  basis: number;
  funding: number;
  /** Fees paid so far, plus the exit fees still to pay while open. */
  fees: number;
  net: number;
  r: number;
  /** Funding yield annualised on notional. */
  apr: number;
  days: number;
}

/** Mark-to-market P&L of a basis position at the given prices (exit fees included while open). */
export function basisPnl(p: BasisLeg & { funding: number; openedAt: number }, spot: number, perp: number, now: number): BasisPnl {
  const spotPnl = p.qty * (spot - p.spotEntry);
  const perpPnl = p.qty * (p.perpEntry - perp);
  const entryFees = p.qty * (p.spotEntry * p.spotFee + p.perpEntry * p.perpFee);
  const exitFees = p.qty * (spot * p.spotFee + perp * p.perpFee);
  const fees = entryFees + exitFees;
  const net = spotPnl + perpPnl + p.funding - fees;
  const notional = p.qty * p.spotEntry;
  const days = Math.max((now - p.openedAt) / 86_400_000, 1 / 24);
  const cost = roundTripCost(p);
  return { spot: spotPnl, perp: perpPnl, basis: spotPnl + perpPnl, funding: p.funding, fees, net, r: cost > 0 ? net / cost : 0, apr: notional > 0 ? (p.funding / notional) * (365 / days) : 0, days };
}

/** Funding settlements a position needs to pay back its round trip at a steady rate. */
export function breakEvenSettlements(rate: number, rules: Pick<BasisRules, 'spotFee' | 'perpFee'>): number | null {
  if (!(rate > 0)) return null;
  return Math.ceil((2 * (rules.spotFee + rules.perpFee)) / rate);
}

/** Annualised yield of a per-settlement rate (three settlements a day on Binance). */
export const settlementApr = (rate: number, perDay = 3) => rate * perDay * 365;

export type BasisSignal = 'enter' | 'hold' | 'exit' | 'wait';

/**
 * Entry and exit rules. Enter: predicted rate ≥ entryRate and the 3-day average positive (one hot
 * print is not a carry). Exit: the last settled rate or the predicted rate below exitRate.
 */
export function basisSignal(open: boolean, f: { predicted: number; lastSettled: number | null; avg3d: number | null }, rules: Pick<BasisRules, 'entryRate' | 'exitRate'>): BasisSignal {
  if (open) return f.predicted < rules.exitRate || (f.lastSettled !== null && f.lastSettled < rules.exitRate) ? 'exit' : 'hold';
  return f.predicted >= rules.entryRate && (f.avg3d ?? 0) > 0 ? 'enter' : 'wait';
}

/**
 * A funded basis account: capital split between the spot wallet (buys the long leg outright) and the
 * futures wallet (margin for the short perp). With the short at leverage L, notional N needs N/L of
 * margin, so capital C funds N = C·L/(L+1) of spot and C/(L+1) of margin. Lower leverage leaves more
 * margin per unit notional: the buffer against a spike before the short is liquidated.
 */
export interface BasisAccountRules {
  capital: number;
  /** Short-leg leverage (1 = fully margined: spot and margin each half the capital). */
  leverage: number;
  /** Maintenance margin rate of the perp tier (Binance BTC/ETH ≈ 0.4%, alts 0.5–1%). */
  mmr: number;
  /** Move margin back over to restore the buffer when the perp has risen this share of the way to liquidation. */
  rebalanceAt: number;
  /** Smallest order the venue accepts per leg, in quote. */
  minNotional: number;
}

export interface BasisAllocation { notional: number; spot: number; margin: number; reserve: number }

/** Split capital into spot, margin and an untouched reserve (kept aside to top up margin). */
export function basisAllocation(r: Pick<BasisAccountRules, 'capital' | 'leverage'>, reserveShare = 0): BasisAllocation {
  const reserve = r.capital * reserveShare;
  const working = r.capital - reserve;
  const notional = (working * r.leverage) / (r.leverage + 1);
  return { notional, spot: notional, margin: working - notional, reserve };
}

/** Isolated-margin liquidation price of a short: where margin + funding falls to maintenance. */
export function shortLiquidationPrice(entry: number, qty: number, margin: number, mmr: number): number {
  if (!(qty > 0)) return Infinity;
  return (margin + entry * qty) / (qty * (1 + mmr));
}

/** How far (as a fraction) the perp can rise from `mark` before the short is liquidated. */
export const liquidationBuffer = (mark: number, liq: number) => (Number.isFinite(liq) && mark > 0 ? liq / mark - 1 : Infinity);

/** Highest leverage whose buffer survives a rise of `spike` (e.g. 0.6 for +60%) with maintenance margin `mmr`. */
export const maxLeverageFor = (spike: number, mmr: number) => 1 / ((1 + spike) * (1 + mmr) - 1);

/**
 * Margin to move from the spot wallet (by selling spot gains) so the buffer is back at `target` at
 * `mark`. The spot leg has gained what the short lost, so the hedge stays whole; this is a transfer
 * plus a small sale, not a loss.
 */
export function marginTopUp(mark: number, qty: number, margin: number, perpEntry: number, mmr: number, target: number): number {
  const needLiq = mark * (1 + target);
  const needMargin = needLiq * qty * (1 + mmr) - perpEntry * qty;
  return Math.max(0, needMargin - margin);
}
