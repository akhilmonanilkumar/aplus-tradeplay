import "server-only";
import { changePct, correlation, emaTrend, rollingCorrelation, zscore, type Point } from "@aplus/engine";
import { cached, errMsg, getJson } from "@/lib/server/http";

/**
 * Cross-asset context for each desk: the US dollar (DXY), yields, equities, silver,
 * ETH, and the correlation of each with the desk's asset on hourly returns.
 * Hourly bars come from Yahoo Finance's public chart API (free, unofficial); real yields
 * from FRED when FRED_API_KEY is set; gold positioning from the CFTC COT report.
 */

export interface MacroSeries {
  id: string;
  label: string;
  symbol: string;
  last: number | null;
  chg24h: number | null;
  /** For yields: change in basis points over 24 h. */
  chgBp24h?: number | null;
  trend: -1 | 0 | 1;
  corr30d: number | null;
  corr7d: number | null;
  beta30d: number | null;
  /** Rolling 48 h correlation, last 7 days. */
  rolling: Point[];
  spark: number[];
}

export interface Macro {
  desk: "gold" | "btc";
  base: string;
  at: number;
  series: MacroSeries[];
  realYield: { date: string; value: number; chgBp5d: number | null } | null;
  cot: { date: string; netLong: number; long: number; short: number; oi: number; z: number | null; chgWeek: number | null } | null;
  errors: string[];
}

const SETS: Record<"gold" | "btc", { base: { symbol: string; label: string }; others: { id: string; symbol: string; label: string; yield?: boolean }[] }> = {
  gold: {
    base: { symbol: "GC=F", label: "Gold (COMEX, for returns)" },
    others: [
      { id: "dxy", symbol: "DX-Y.NYB", label: "US Dollar Index" },
      { id: "us10y", symbol: "^TNX", label: "US 10Y yield", yield: true },
      { id: "silver", symbol: "SI=F", label: "Silver" },
      { id: "eurusd", symbol: "EURUSD=X", label: "EUR/USD" },
      { id: "usdjpy", symbol: "JPY=X", label: "USD/JPY" },
      { id: "nq", symbol: "NQ=F", label: "Nasdaq-100 fut." },
      { id: "btc", symbol: "BTC-USD", label: "Bitcoin" },
    ],
  },
  btc: {
    base: { symbol: "BTC-USD", label: "Bitcoin" },
    others: [
      { id: "eth", symbol: "ETH-USD", label: "Ether" },
      { id: "nq", symbol: "NQ=F", label: "Nasdaq-100 fut." },
      { id: "es", symbol: "ES=F", label: "S&P 500 fut." },
      { id: "dxy", symbol: "DX-Y.NYB", label: "US Dollar Index" },
      { id: "us10y", symbol: "^TNX", label: "US 10Y yield", yield: true },
      { id: "gold", symbol: "GC=F", label: "Gold" },
    ],
  },
};

type YChart = { chart: { result?: { timestamp?: number[]; indicators: { quote: { close: (number | null)[] }[] } }[]; error?: { description: string } | null } };

async function yahoo(symbol: string): Promise<Point[]> {
  return cached(`y:${symbol}`, 5 * 60_000, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=60m&range=1mo&includePrePost=false`;
    let j: YChart;
    try { j = await getJson<YChart>(url); } catch { j = await getJson<YChart>(url.replace("query1", "query2")); }
    const r = j.chart.result?.[0];
    if (!r?.timestamp) throw new Error(j.chart.error?.description ?? "no data");
    const close = r.indicators.quote[0]?.close ?? [];
    const out: Point[] = [];
    r.timestamp.forEach((ts, i) => {
      const v = close[i];
      if (v !== null && v !== undefined && Number.isFinite(v)) out.push({ t: Math.floor((ts * 1000) / 3_600_000) * 3_600_000, v });
    });
    return out;
  });
}

const at24hAgo = (s: Point[]) => {
  const last = s.at(-1);
  if (!last) return null;
  return [...s].reverse().find((p) => p.t <= last.t - 24 * 3_600_000) ?? null;
};

export function loadMacro(desk: "gold" | "btc"): Promise<Macro> {
  return cached(`m:${desk}`, 5 * 60_000, async () => {
    const set = SETS[desk];
    const errors: string[] = [];
    const base = await yahoo(set.base.symbol).catch((e) => { errors.push(`${set.base.label}: ${errMsg(e)}`); return [] as Point[]; });
    const weekAgo = Date.now() - 7 * 86_400_000;
    const series = await Promise.all(set.others.map(async (o): Promise<MacroSeries> => {
      try {
        const s = await yahoo(o.symbol);
        const vals = s.map((p) => p.v);
        const prev = at24hAgo(s);
        const last = s.at(-1)?.v ?? null;
        const c30 = base.length ? correlation(base, s, 24 * 30) : { corr: null, beta: null, n: 0 };
        const c7 = base.length ? correlation(base, s, 24 * 7) : { corr: null, beta: null, n: 0 };
        return {
          id: o.id, label: o.label, symbol: o.symbol, last,
          chg24h: last !== null && prev ? ((last - prev.v) / prev.v) * 100 : changePct(vals, 24),
          chgBp24h: o.yield && last !== null && prev ? (last - prev.v) * 100 : undefined,
          trend: emaTrend(vals, 20, 50, o.yield ? 0.05 : 0.02).dir,
          corr30d: c30.corr, corr7d: c7.corr, beta30d: c30.beta,
          rolling: base.length ? rollingCorrelation(base, s, 48).filter((p) => p.t >= weekAgo) : [],
          spark: vals.slice(-120),
        };
      } catch (e) {
        errors.push(`${o.label}: ${errMsg(e)}`);
        return { id: o.id, label: o.label, symbol: o.symbol, last: null, chg24h: null, trend: 0, corr30d: null, corr7d: null, beta30d: null, rolling: [], spark: [] };
      }
    }));

    const [realYield, cot] = await Promise.all([
      desk === "gold" ? loadRealYield().catch((e) => { errors.push(`FRED: ${errMsg(e)}`); return null; }) : null,
      desk === "gold" ? loadCot().catch((e) => { errors.push(`CFTC COT: ${errMsg(e)}`); return null; }) : null,
    ]);
    return { desk, base: set.base.label, at: Date.now(), series, realYield, cot, errors };
  });
}

/** 10-year TIPS real yield (DFII10), daily. Needs FRED_API_KEY (free). */
async function loadRealYield(): Promise<Macro["realYield"]> {
  const key = process.env.FRED_API_KEY?.trim();
  if (!key) return null;
  const j = await getJson<{ observations: { date: string; value: string }[] }>(`https://api.stlouisfed.org/fred/series/observations?series_id=DFII10&api_key=${key}&file_type=json&sort_order=desc&limit=10`);
  const obs = j.observations.filter((o) => o.value !== ".").map((o) => ({ date: o.date, value: Number(o.value) }));
  if (!obs.length) return null;
  return { date: obs[0]!.date, value: obs[0]!.value, chgBp5d: obs[5] ? (obs[0]!.value - obs[5].value) * 100 : null };
}

/** CFTC disaggregated futures-only report, COMEX gold (088691): managed-money positioning, weekly. */
async function loadCot(): Promise<Macro["cot"]> {
  return cached("cot:gold", 6 * 3_600_000, async () => {
    const q = new URLSearchParams({ cftc_contract_market_code: "088691", $order: "report_date_as_yyyy_mm_dd DESC", $limit: "52" });
    const rows = await getJson<{ report_date_as_yyyy_mm_dd: string; m_money_positions_long_all: string; m_money_positions_short_all: string; open_interest_all: string }[]>(`https://publicreporting.cftc.gov/resource/72hh-3qpy.json?${q}`);
    if (!rows.length) return null;
    const nets = rows.map((r) => Number(r.m_money_positions_long_all) - Number(r.m_money_positions_short_all)).reverse();
    const r0 = rows[0]!;
    const long = Number(r0.m_money_positions_long_all), short = Number(r0.m_money_positions_short_all);
    return { date: r0.report_date_as_yyyy_mm_dd.slice(0, 10), netLong: long - short, long, short, oi: Number(r0.open_interest_all), z: zscore(nets), chgWeek: nets.length > 1 ? nets.at(-1)! - nets.at(-2)! : null };
  });
}
