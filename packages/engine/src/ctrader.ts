/**
 * cTrader: symbol specs for the CFD Arena and signal links. A signal link opens cTrader's order screen
 * pre-filled (help.ctrader.com → Signal links). Volume travels only with split take-profits, so every
 * alert carries TP1 and TP2 legs, which also lets each account get its own size.
 */

export interface CTraderSpec { symbol: string; unitsPerLot: number; lotStep: number; minLot: number; digits: number; quote: 'USD' | 'JPY' }

/** Typical cTrader CFD contracts. A firm's server can differ: an account may override them in its rules. */
export const CTRADER_SPECS: Record<string, CTraderSpec> = {
  XAUUSD: { symbol: 'XAUUSD', unitsPerLot: 100, lotStep: 0.01, minLot: 0.01, digits: 2, quote: 'USD' },
  BTCUSD: { symbol: 'BTCUSD', unitsPerLot: 1, lotStep: 0.01, minLot: 0.01, digits: 2, quote: 'USD' },
  EURUSD: { symbol: 'EURUSD', unitsPerLot: 100_000, lotStep: 0.01, minLot: 0.01, digits: 5, quote: 'USD' },
  GBPUSD: { symbol: 'GBPUSD', unitsPerLot: 100_000, lotStep: 0.01, minLot: 0.01, digits: 5, quote: 'USD' },
  USDJPY: { symbol: 'USDJPY', unitsPerLot: 100_000, lotStep: 0.01, minLot: 0.01, digits: 3, quote: 'JPY' },
  US500: { symbol: 'US500', unitsPerLot: 1, lotStep: 0.01, minLot: 0.01, digits: 2, quote: 'USD' },
  NAS100: { symbol: 'NAS100', unitsPerLot: 1, lotStep: 0.01, minLot: 0.01, digits: 2, quote: 'USD' },
};

/** Engine instrument → cTrader CFD symbol (perps and spot map to the matching CFD). */
export function toCTraderSymbol(instrument: string): string | null {
  if (instrument.startsWith('XAU')) return 'XAUUSD';
  if (instrument.startsWith('BTC')) return 'BTCUSD';
  if (instrument === 'SPX500') return 'US500';
  return CTRADER_SPECS[instrument] ? instrument : null;
}

/** USD per 1.0 price move per lot. JPY-quoted pairs convert at the trade price. */
export function valuePerPointPerLot(spec: CTraderSpec, price: number): number {
  return spec.quote === 'JPY' ? spec.unitsPerLot / price : spec.unitsPerLot;
}

export interface SignalLinkInput {
  symbol: string;
  order: 'market' | 'limit' | 'stop';
  direction: 'buy' | 'sell';
  price?: number;
  sl?: number;
  /** Take-profit legs with their volume in units (lots × units per lot). */
  tps: { price: number; units: number }[];
  expiry?: Date;
  comment?: string;
  digits: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** DD-MM-YYYY_hh-mm in UTC. */
export const ctraderExpiry = (d: Date) => `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;

/** Prices without trailing zeros, dot decimal. */
const px = (x: number, digits: number) => String(Number(x.toFixed(digits)));
const units = (x: number) => String(Math.round(x));

/** Latin characters only, 100 at most (cTrader's comment rule). */
export const ctraderComment = (s: string) => s.replace(/[^A-Za-z0-9 .,:;_+\-/#()]/g, '').trim().slice(0, 100);

export function ctraderSignalLink(x: SignalLinkInput): string {
  const q: [string, string][] = [['s', x.symbol], ['o', x.order], ['d', x.direction]];
  if (x.order !== 'market' && x.price !== undefined) q.push(['p', px(x.price, x.digits)]);
  if (x.sl !== undefined) q.push(['sl', px(x.sl, x.digits)]);
  const legs = x.tps.filter((t) => t.units > 0);
  if (legs.length > 1) {
    q.push(['v', units(legs.reduce((a, t) => a + t.units, 0))]);
    legs.forEach((t, i) => { q.push([i ? `tp${i + 1}` : 'tp', px(t.price, x.digits)]); q.push([i ? `tpv${i + 1}` : 'tpv', units(t.units)]); });
  } else if (legs[0]) {
    q.push(['tp', px(legs[0].price, x.digits)]);
  }
  if (x.comment) q.push(['c', ctraderComment(x.comment)]);
  if (x.expiry && x.order !== 'market') q.push(['e-utc', ctraderExpiry(x.expiry)]);
  return `https://app.ctrader.com/signal?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}
