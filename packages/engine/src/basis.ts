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
