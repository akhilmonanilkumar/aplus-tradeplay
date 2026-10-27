import "server-only";
import { getJson } from "@/lib/server/http";

/**
 * Funding basis research: how often funding is positive, how long negative runs last, what the
 * enter-on-positive / exit-on-negative rule would have earned after fees, and how far the perp has
 * spiked over 1–30 days (the move the short leg's margin has to survive). Read-only.
 */

type Settled = { fundingTime: number; fundingRate: string };
type Kline = [number, string, string, string, string, ...unknown[]];

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
};
const r6 = (x: number | null) => (x === null ? null : Number(x.toFixed(6)));
const r2 = (x: number | null) => (x === null ? null : Number(x.toFixed(2)));

async function fundingHistory(symbol: string): Promise<{ t: number; rate: number }[]> {
  // Two pages of 1,000 settlements reach back ~22 months at 8h.
  const out: { t: number; rate: number }[] = [];
  let end = Date.now();
  for (let page = 0; page < 2; page++) {
    const rows = await getJson<Settled[]>(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1000&endTime=${end}`, { timeoutMs: 15_000 });
    if (!rows.length) break;
    out.unshift(...rows.map((x) => ({ t: x.fundingTime, rate: Number(x.fundingRate) })));
    end = rows[0]!.fundingTime - 1;
    if (rows.length < 1000) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Enter when the last settled rate ≥ entry and the last 9 average > 0; exit when a settlement < exit. */
function simulate(h: { t: number; rate: number }[], entry: number, exit: number, roundTrip: number) {
  const trades: { start: number; end: number; n: number; funding: number; net: number }[] = [];
  let open: { start: number; funding: number; n: number } | null = null;
  for (let i = 9; i < h.length; i++) {
    const x = h[i]!;
    if (open) {
      open.funding += x.rate; open.n++;
      if (x.rate < exit) { trades.push({ start: open.start, end: x.t, n: open.n, funding: open.funding, net: open.funding - roundTrip }); open = null; }
      continue;
    }
    const avg = h.slice(i - 8, i + 1).reduce((a, b) => a + b.rate, 0) / 9;
    if (x.rate >= entry && avg > 0) open = { start: x.t, funding: 0, n: 0 };
  }
  if (open) trades.push({ start: open.start, end: h.at(-1)!.t, n: open.n, funding: open.funding, net: open.funding - roundTrip });
  const days = h.length ? (h.at(-1)!.t - h[9]!.t) / 86_400_000 : 0;
  const total = trades.reduce((a, t) => a + t.net, 0);
  const inMarket = trades.reduce((a, t) => a + (t.end - t.start), 0) / 86_400_000;
  return {
    trades: trades.length, wins: trades.filter((t) => t.net > 0).length,
    avgHoldDays: r2(trades.length ? inMarket / trades.length : null), timeInMarket: r2(days ? inMarket / days : null),
    netPctOnNotional: r2(total * 100), aprOnNotional: r2(days ? total * 100 * (365 / days) : null),
    feesPct: r2(trades.length * roundTrip * 100), bestPct: r2(trades.length ? Math.max(...trades.map((t) => t.net)) * 100 : null), worstPct: r2(trades.length ? Math.min(...trades.map((t) => t.net)) * 100 : null),
  };
}

/** Largest rise of the perp's high above a starting close within N days, over every start day. */
function spikes(k: Kline[]) {
  const close = k.map((x) => Number(x[4])), high = k.map((x) => Number(x[2])), open = k.map((x) => Number(x[1]));
  const rise = (n: number) => {
    const xs: number[] = [];
    for (let i = 0; i + 1 < k.length; i++) {
      let m = 0;
      for (let j = i + 1; j <= Math.min(k.length - 1, i + n); j++) m = Math.max(m, high[j]! / close[i]! - 1);
      xs.push(m);
    }
    return { p95: r2((pct(xs, 0.95) ?? 0) * 100), p99: r2((pct(xs, 0.99) ?? 0) * 100), max: r2(Math.max(...xs) * 100) };
  };
  const intraday = open.map((o, i) => high[i]! / o - 1);
  return { days: k.length, intradayMaxPct: r2(Math.max(...intraday) * 100), d1: rise(1), d3: rise(3), d7: rise(7), d30: rise(30) };
}

export async function basisResearch(symbols: string[], fees = { spot: 0.001, perp: 0.0005 }) {
  const roundTrip = 2 * (fees.spot + fees.perp);
  const rows = await Promise.all(symbols.map(async (symbol) => {
    try {
      const [h, k] = await Promise.all([
        fundingHistory(symbol),
        getJson<Kline[]>(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=1000`, { timeoutMs: 15_000 }),
      ]);
      const rates = h.map((x) => x.rate);
      let streak = 0, longestNeg = 0, negRuns = 0;
      for (const r of rates) { if (r < 0) { if (!streak) negRuns++; streak++; longestNeg = Math.max(longestNeg, streak); } else streak = 0; }
      const gaps = h.slice(1).map((x, i) => (x.t - h[i]!.t) / 3_600_000);
      const last90 = h.filter((x) => x.t > Date.now() - 90 * 86_400_000).map((x) => x.rate);
      return {
        symbol, from: h[0] ? new Date(h[0].t).toISOString().slice(0, 10) : null, settlements: h.length,
        intervalHours: [...new Set(gaps.map((g) => Math.round(g)))].slice(0, 4),
        positiveShare: r2(rates.filter((r) => r > 0).length / (rates.length || 1) * 100),
        aboveEntryShare: r2(rates.filter((r) => r >= 0.0001).length / (rates.length || 1) * 100),
        mean: r6(rates.reduce((a, b) => a + b, 0) / (rates.length || 1)), median: r6(pct(rates, 0.5)), p10: r6(pct(rates, 0.1)), p90: r6(pct(rates, 0.9)), min: r6(Math.min(...rates)), max: r6(Math.max(...rates)),
        mean90d: r6(last90.length ? last90.reduce((a, b) => a + b, 0) / last90.length : null),
        longestNegativeRun: longestNeg, negativeRuns: negRuns,
        rule: {
          base: simulate(h, 0.0001, 0, roundTrip),
          exitBelowHalf: simulate(h, 0.0001, 0.00005, roundTrip),
          entry2bp: simulate(h, 0.0002, 0, roundTrip),
          makerFees: simulate(h, 0.0001, 0, 2 * (0.00075 + 0.0002)),
        },
        perpSpikes: spikes(k),
      };
    } catch (e) {
      return { symbol, error: (e as Error).message };
    }
  }));
  return { at: Date.now(), roundTripPct: roundTrip * 100, symbols: rows };
}
