import "server-only";
import { basisPct, fundingApr, fundingState, oiRegime, type FundingState, type OiRegime } from "@aplus/engine";
import { cached, errMsg, getJson } from "@/lib/server/http";

/**
 * Perpetual-futures positioning for BTCUSDT and XAUUSDT: funding (now and history),
 * open interest and its change over 1h/4h/24h matched with price change (the regime),
 * long/short ratios, taker aggressor flow, perp basis, and OI/funding on other venues.
 */

export interface Derivs {
  symbol: string;
  at: number;
  mark: number | null;
  index: number | null;
  basisPct: number | null;
  funding: { last: number | null; next: number | null; apr: number | null; state: FundingState | null; history: { t: number; rate: number }[] };
  oi: {
    now: number | null;
    nowUsd: number | null;
    hist: { t: number; oi: number; usd: number }[];
    windows: { label: string; oiChg: number | null; priceChg: number | null; regime: OiRegime | null }[];
  };
  ls: { global: { t: number; ratio: number; long: number }[]; top: { t: number; ratio: number; long: number }[] };
  taker: { t: number; buy: number; sell: number; ratio: number }[];
  venues: { venue: string; oiUsd: number | null; funding: number | null }[];
  errors: string[];
}

const F = "https://fapi.binance.com";
const n = (x: unknown) => (x === null || x === undefined || x === "" ? null : Number(x));

export function loadDerivs(symbol: "BTCUSDT" | "XAUUSDT"): Promise<Derivs> {
  return cached(`d:${symbol}`, 30_000, async () => {
    const errors: string[] = [];
    const safe = async <T,>(label: string, p: Promise<T>): Promise<T | null> => { try { return await p; } catch (e) { errors.push(`${label}: ${errMsg(e)}`); return null; } };
    const [pi, fr, oiNow, oi5, oi1h, gls, tls, tk, k5, k1h, bybit, okxOi, okxFr] = await Promise.all([
      safe("premium index", getJson<{ markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number }>(`${F}/fapi/v1/premiumIndex?symbol=${symbol}`)),
      safe("funding history", getJson<{ fundingTime: number; fundingRate: string }[]>(`${F}/fapi/v1/fundingRate?symbol=${symbol}&limit=90`)),
      safe("open interest", getJson<{ openInterest: string; time: number }>(`${F}/fapi/v1/openInterest?symbol=${symbol}`)),
      safe("OI 5m", getJson<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]>(`${F}/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=288`)),
      safe("OI 1h", getJson<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]>(`${F}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=168`)),
      safe("global L/S", getJson<{ longShortRatio: string; longAccount: string; timestamp: number }[]>(`${F}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=48`)),
      safe("top L/S", getJson<{ longShortRatio: string; longAccount: string; timestamp: number }[]>(`${F}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=48`)),
      safe("taker flow", getJson<{ buySellRatio: string; buyVol: string; sellVol: string; timestamp: number }[]>(`${F}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=48`)),
      safe("price 5m", getJson<(string | number)[][]>(`${F}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=289`)),
      safe("price 1h", getJson<(string | number)[][]>(`${F}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=169`)),
      symbol === "BTCUSDT" ? safe("bybit", getJson<{ result: { list: { openInterestValue: string; fundingRate: string }[] } }>("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT")) : null,
      symbol === "BTCUSDT" ? safe("okx OI", getJson<{ data: { oiUsd: string }[] }>("https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP")) : null,
      symbol === "BTCUSDT" ? safe("okx funding", getJson<{ data: { fundingRate: string }[] }>("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP")) : null,
    ]);

    const mark = n(pi?.markPrice), index = n(pi?.indexPrice), last = n(pi?.lastFundingRate);
    const hist5 = (oi5 ?? []).map((x) => ({ t: x.timestamp, oi: Number(x.sumOpenInterest), usd: Number(x.sumOpenInterestValue) }));
    const hist1h = (oi1h ?? []).map((x) => ({ t: x.timestamp, oi: Number(x.sumOpenInterest), usd: Number(x.sumOpenInterestValue) }));
    const px5 = (k5 ?? []).map((r) => ({ t: Number(r[0]), c: Number(r[4]) }));
    const px1h = (k1h ?? []).map((r) => ({ t: Number(r[0]), c: Number(r[4]) }));

    // Change over a window: compare the latest point with the one `ms` earlier (closest at or before).
    const chg = (series: { t: number; v: number }[], ms: number): number | null => {
      const lastP = series.at(-1);
      if (!lastP) return null;
      const base = [...series].reverse().find((p) => p.t <= lastP.t - ms);
      return base && base.v ? ((lastP.v - base.v) / base.v) * 100 : null;
    };
    const oiS5 = hist5.map((x) => ({ t: x.t, v: x.oi })), oiS1h = hist1h.map((x) => ({ t: x.t, v: x.oi }));
    const pS5 = px5.map((x) => ({ t: x.t, v: x.c })), pS1h = px1h.map((x) => ({ t: x.t, v: x.c }));
    const windows = [
      { label: "1h", oiChg: chg(oiS5, 3_600_000), priceChg: chg(pS5, 3_600_000) },
      { label: "4h", oiChg: chg(oiS5, 4 * 3_600_000), priceChg: chg(pS5, 4 * 3_600_000) },
      { label: "24h", oiChg: chg(oiS1h, 24 * 3_600_000), priceChg: chg(pS1h, 24 * 3_600_000) },
      { label: "7d", oiChg: chg(oiS1h, 6.9 * 86_400_000), priceChg: chg(pS1h, 6.9 * 86_400_000) },
    ].map((w) => ({ ...w, regime: w.oiChg !== null && w.priceChg !== null ? oiRegime(w.priceChg, w.oiChg, w.label === "1h" ? 0.15 : 0.3, w.label === "1h" ? 0.3 : 0.5) : null }));

    const venues: Derivs["venues"] = [{ venue: "Binance", oiUsd: hist5.at(-1)?.usd ?? null, funding: last }];
    if (bybit?.result?.list?.[0]) venues.push({ venue: "Bybit", oiUsd: n(bybit.result.list[0].openInterestValue), funding: n(bybit.result.list[0].fundingRate) });
    if (okxOi?.data?.[0] || okxFr?.data?.[0]) venues.push({ venue: "OKX", oiUsd: n(okxOi?.data?.[0]?.oiUsd), funding: n(okxFr?.data?.[0]?.fundingRate) });

    return {
      symbol,
      at: Date.now(),
      mark,
      index,
      basisPct: mark !== null && index !== null ? basisPct(mark, index) : null,
      funding: {
        last,
        next: pi?.nextFundingTime ?? null,
        apr: last !== null ? fundingApr(last) : null,
        state: last !== null ? fundingState(last) : null,
        history: (fr ?? []).map((x) => ({ t: x.fundingTime, rate: Number(x.fundingRate) })),
      },
      oi: { now: n(oiNow?.openInterest), nowUsd: hist5.at(-1)?.usd ?? null, hist: hist1h, windows },
      ls: {
        global: (gls ?? []).map((x) => ({ t: x.timestamp, ratio: Number(x.longShortRatio), long: Number(x.longAccount) })),
        top: (tls ?? []).map((x) => ({ t: x.timestamp, ratio: Number(x.longShortRatio), long: Number(x.longAccount) })),
      },
      taker: (tk ?? []).map((x) => ({ t: x.timestamp, buy: Number(x.buyVol), sell: Number(x.sellVol), ratio: Number(x.buySellRatio) })),
      venues,
      errors,
    };
  });
}
