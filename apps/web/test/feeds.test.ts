import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vendor parsers against payloads in each API's documented shape. The fetch mock
 * routes by URL; anything unmatched fails like a blocked host, exercising the fallbacks.
 */
type Route = [RegExp, unknown | ((url: string) => unknown), number?];
let routes: Route[] = [];
const calls: string[] = [];

beforeEach(() => {
  vi.resetModules();
  routes = [];
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const r = routes.find(([re]) => re.test(url));
    if (!r) return new Response("blocked", { status: 403 });
    const body = typeof r[1] === "function" ? (r[1] as (u: string) => unknown)(url) : r[1];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: r[2] ?? 200 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.OANDA_API_KEY; delete process.env.TWELVEDATA_API_KEY; });

const M5 = 300_000;
/** n consecutive 5-minute bars ending with the currently forming one. */
function bars(n: number, start = 100) {
  const now = Date.now();
  const lastOpen = Math.floor(now / M5) * M5;
  return Array.from({ length: n }, (_, i) => {
    const t = lastOpen - (n - 1 - i) * M5;
    const o = start + i;
    return { t, o, h: o + 2, l: o - 1, c: o + 1 };
  });
}

describe("candles", () => {
  it("parses Binance mark-price klines and splits closed vs forming", async () => {
    const b = bars(40, 60000);
    routes.push([/fapi\.binance\.com\/fapi\/v1\/markPriceKlines/, b.map((x) => [x.t, String(x.o), String(x.h), String(x.l), String(x.c), "0", x.t + M5 - 1])]);
    const { loadCandles } = await import("@/lib/server/feeds");
    const r = await loadCandles("BTCUSDT.P", "5m", 30);
    expect(r.source).toBe("Binance BTCUSDT.P mark");
    expect(r.approx).toBe(false);
    expect(r.candles).toHaveLength(30);
    expect(r.forming?.t).toBe(b.at(-1)!.t);
    expect(r.candles.every((c) => c.t + M5 <= Date.now())).toBe(true);
    expect(r.candles.at(-1)!.c).toBe(b.at(-2)!.c);
  });

  it("falls back to Bybit (newest-first list) when Binance is blocked", async () => {
    const b = bars(40, 60000);
    routes.push([/api\.bybit\.com\/v5\/market\/mark-price-kline/, { retCode: 0, retMsg: "OK", result: { list: [...b].reverse().map((x) => [String(x.t), String(x.o), String(x.h), String(x.l), String(x.c)]) } }]);
    const { loadCandles } = await import("@/lib/server/feeds");
    const r = await loadCandles("BTCUSDT.P", "5m", 30);
    expect(r.source).toBe("Bybit BTCUSDT mark");
    expect(r.approx).toBe(true);
    expect(r.candles[0]!.t).toBeLessThan(r.candles.at(-1)!.t);
  });

  it("uses OANDA mid candles for XAUUSD when a key is set", async () => {
    process.env.OANDA_API_KEY = "test";
    const b = bars(40, 4100);
    routes.push([/api-fxpractice\.oanda\.com\/v3\/instruments\/XAU_USD\/candles/, (url: string) => {
      expect(url).toContain("granularity=M5");
      expect(url).toContain("price=M");
      return { candles: b.map((x, i) => ({ complete: i < b.length - 1, time: new Date(x.t).toISOString(), volume: 10, mid: { o: String(x.o), h: String(x.h), l: String(x.l), c: String(x.c) } })) };
    }]);
    const { loadCandles } = await import("@/lib/server/feeds");
    const r = await loadCandles("XAUUSD", "5m", 30);
    expect(r.source).toBe("OANDA XAU/USD");
    expect(r.approx).toBe(false);
    expect(r.candles.at(-1)!.h).toBe(b.at(-2)!.h);
    const auth = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].headers as Record<string, string>;
    expect(auth.authorization).toBe("Bearer test");
  });

  it("without keys, gold falls back to the labelled Binance XAU index", async () => {
    const b = bars(40, 4100);
    routes.push([/indexPriceKlines\?pair=XAUUSDT/, b.map((x) => [x.t, String(x.o), String(x.h), String(x.l), String(x.c)])]);
    const { loadCandles } = await import("@/lib/server/feeds");
    const r = await loadCandles("XAUUSD", "5m", 30);
    expect(r.source).toContain("XAU index");
    expect(r.approx).toBe(true);
    expect(r.note).toMatch(/OANDA|Twelve Data/);
  });

  it("parses Twelve Data (UTC datetimes) for XAU/USD", async () => {
    process.env.TWELVEDATA_API_KEY = "td";
    const b = bars(40, 4100);
    routes.push([/api\.twelvedata\.com\/time_series/, { status: "ok", values: b.map((x) => ({ datetime: new Date(x.t).toISOString().slice(0, 19).replace("T", " "), open: String(x.o), high: String(x.h), low: String(x.l), close: String(x.c) })) }]);
    const { loadCandles } = await import("@/lib/server/feeds");
    const r = await loadCandles("XAUUSD", "5m", 30);
    expect(r.source).toBe("Twelve Data XAU/USD");
    expect(r.candles.at(-1)!.t).toBe(b.at(-2)!.t);
  });

  it("builds 15M and 1H from one Twelve Data 5M pull (rate-limit budget)", async () => {
    process.env.TWELVEDATA_API_KEY = "td";
    const b = bars(600, 4100);
    routes.push([/api\.twelvedata\.com\/time_series/, (url: string) => {
      expect(url).toContain("interval=5min");
      expect(url).toContain("outputsize=5000");
      return { status: "ok", values: b.map((x) => ({ datetime: new Date(x.t).toISOString().slice(0, 19).replace("T", " "), open: String(x.o), high: String(x.h), low: String(x.l), close: String(x.c) })) };
    }]);
    const { loadCandles } = await import("@/lib/server/feeds");
    const [m5, m15, h1] = await Promise.all([loadCandles("XAUUSD", "5m", 300), loadCandles("XAUUSD", "15m", 100), loadCandles("XAUUSD", "1h", 30)]);
    expect(calls.filter((u) => u.includes("twelvedata")).length).toBe(1);
    expect(m15.candles.every((c) => c.t % 900_000 === 0)).toBe(true);
    expect(h1.candles.every((c) => c.t % 3_600_000 === 0)).toBe(true);
    const hour = h1.candles.at(-1)!;
    const inside = b.filter((x) => x.t >= hour.t && x.t < hour.t + 3_600_000);
    expect(hour.h).toBe(Math.max(...inside.map((x) => x.h)));
    expect(hour.o).toBe(inside[0]!.o);
    expect(m5.source).toBe("Twelve Data XAU/USD");
  });

  it("parses Coinbase (seconds, low/high/open/close order) and builds 4H from 1H", async () => {
    const H = 3_600_000;
    const lastOpen = Math.floor(Date.now() / H) * H;
    routes.push([/api\.exchange\.coinbase\.com\/products\/BTC-USD\/candles/, (url: string) => {
      expect(url).toContain("granularity=3600");
      const end = Date.parse(new URL(url).searchParams.get("end")!);
      const out: number[][] = [];
      for (let t = Math.floor(end / H) * H, k = 0; k < 300; k++, t -= H) if (t <= lastOpen) out.push([t / 1000, 90, 110, 100, 105, 1]);
      return out; // newest first, like the API
    }]);
    const { loadCandles } = await import("@/lib/server/feeds");
    const r = await loadCandles("BTCUSD.SPOT", "4h", 20);
    expect(r.source).toBe("Coinbase BTC-USD");
    expect(r.candles.every((c) => c.t % (4 * H) === 0)).toBe(true);
    expect(r.candles[0]).toMatchObject({ o: 100, h: 110, l: 90, c: 105 });
  });

  it("reports every provider error when all fail", async () => {
    const { loadCandles } = await import("@/lib/server/feeds");
    await expect(loadCandles("XAUUSDT.P", "5m", 30)).rejects.toThrow(/Binance XAUUSDT\.P mark.*403/);
  });
});

describe("quotes", () => {
  it("picks the tightest Swissquote spread profile for spot gold", async () => {
    routes.push([/swissquote/, [{ topo: { platform: "SwissquoteLtd" }, ts: 1, spreadProfilePrices: [{ spreadProfile: "standard", bid: 4100, ask: 4100.6 }, { spreadProfile: "prime", bid: 4100.1, ask: 4100.3 }] }]]);
    const { loadQuote } = await import("@/lib/server/feeds");
    const q = await loadQuote("XAUUSD");
    expect(q.source).toBe("Swissquote XAU/USD");
    expect(q.bid).toBe(4100.1);
    expect(q.last).toBeCloseTo(4100.2, 6);
  });
});

describe("derivatives", () => {
  it("computes OI change windows and the regime from Binance futures data", async () => {
    const now = Date.now();
    const five = Array.from({ length: 289 }, (_, i) => now - (288 - i) * M5);
    const hour = Array.from({ length: 169 }, (_, i) => now - (168 - i) * 3_600_000);
    routes.push(
      [/premiumIndex/, { markPrice: "100500", indexPrice: "100400", lastFundingRate: "0.0003", nextFundingTime: now + 3_600_000 }],
      [/fundingRate\?/, [{ fundingTime: now - 8 * 3_600_000, fundingRate: "0.0001" }, { fundingTime: now, fundingRate: "0.0003" }]],
      [/fapi\/v1\/openInterest\?/, { openInterest: "90000", time: now }],
      // OI +5% over the last hour of 5m data, +10% over 24h of hourly data
      [/openInterestHist\?symbol=BTCUSDT&period=5m/, five.map((t, i) => ({ timestamp: t, sumOpenInterest: String(i >= 280 ? 105 : 100), sumOpenInterestValue: String((i >= 280 ? 105 : 100) * 1e6) }))],
      [/openInterestHist\?symbol=BTCUSDT&period=1h/, hour.map((t, i) => ({ timestamp: t, sumOpenInterest: String(i >= 145 ? 110 : 100), sumOpenInterestValue: "1" }))],
      [/globalLongShortAccountRatio/, [{ timestamp: now, longShortRatio: "1.2", longAccount: "0.55" }]],
      [/topLongShortPositionRatio/, [{ timestamp: now, longShortRatio: "1.8", longAccount: "0.64" }]],
      [/takerlongshortRatio/, [{ timestamp: now, buySellRatio: "1.1", buyVol: "110", sellVol: "100" }]],
      // price +1% over the last hour
      [/klines\?symbol=BTCUSDT&interval=5m/, five.map((t, i) => [t, "0", "0", "0", String(i >= 280 ? 101 : 100)])],
      [/klines\?symbol=BTCUSDT&interval=1h/, hour.map((t) => [t, "0", "0", "0", "100"])],
      [/api\.bybit\.com\/v5\/market\/tickers/, { result: { list: [{ openInterestValue: "5000000000", fundingRate: "0.0002" }] } }],
    );
    const { loadDerivs } = await import("@/lib/server/derivs");
    const d = await loadDerivs("BTCUSDT");
    expect(d.basisPct).toBeCloseTo(0.0996, 3);
    expect(d.funding.state).toBe("elevated_long");
    const h1 = d.oi.windows.find((w) => w.label === "1h")!;
    expect(h1.oiChg).toBeCloseTo(5, 6);
    expect(h1.priceChg).toBeCloseTo(1, 6);
    expect(h1.regime).toBe("long_build");
    expect(d.oi.windows.find((w) => w.label === "24h")!.oiChg).toBeCloseTo(10, 6);
    expect(d.venues.map((v) => v.venue)).toEqual(["Binance", "Bybit"]);
    expect(d.errors.some((e) => e.startsWith("okx"))).toBe(true);
  });
});

describe("news & calendar", () => {
  it("parses Google News RSS (publisher suffix, CDATA, entities) and tags tone", async () => {
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title><![CDATA[Gold prices surge to record high as Fed signals cut - Reuters]]></title><link>https://n/1</link><pubDate>${new Date().toUTCString()}</pubDate><source url="x">Reuters</source></item>
      <item><title>Bitcoin &amp; ether slide after hawkish minutes - CoinDesk</title><link>https://n/2</link><pubDate>${new Date(Date.now() - 60000).toUTCString()}</pubDate></item>
    </channel></rss>`;
    routes.push([/news\.google\.com/, rss]);
    const { loadHeadlines } = await import("@/lib/server/news");
    const r = await loadHeadlines("gold");
    const g = r.items.find((h) => h.url === "https://n/1")!;
    expect(g.title).toBe("Gold prices surge to record high as Fed signals cut");
    expect(g.source).toBe("Reuters");
    expect(g.tone).toBe("bullish");
    // the same Google feed answers both gold queries: duplicates are removed
    expect(r.items.filter((h) => h.url === "https://n/1")).toHaveLength(1);
    expect(r.items.find((h) => h.url === "https://n/2")!.tone).toBe("bearish");
  });

  it("maps Forex Factory events to desks and impact", async () => {
    routes.push([/ff_calendar_thisweek/, [
      { title: "CPI m/m", country: "USD", date: "2026-10-28T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.2%" },
      { title: "ECB Press Conference", country: "EUR", date: "2026-10-29T08:45:00-04:00", impact: "High", forecast: "", previous: "" },
      { title: "AUD Retail Sales", country: "AUD", date: "2026-10-27T20:30:00-04:00", impact: "Medium", forecast: "", previous: "" },
    ]]);
    const { loadCalendar } = await import("@/lib/server/news");
    const c = await loadCalendar();
    const cpi = c.items.find((e) => e.title === "CPI m/m")!;
    expect(cpi.at).toBe(Date.parse("2026-10-28T12:30:00Z"));
    expect(cpi.impact).toBe("high");
    expect(cpi.desks).toEqual(["gold", "btc"]);
    expect(c.items.find((e) => e.currency === "EUR")!.desks).toEqual(["gold"]);
    expect(c.items.find((e) => e.currency === "AUD")!.desks).toEqual([]);
  });
});

describe("macro", () => {
  it("parses Yahoo hourly charts and correlates on aligned hours", async () => {
    const H = 3600;
    const t0 = Math.floor(Date.now() / 1000 / H) * H - 400 * H;
    const ts = Array.from({ length: 400 }, (_, i) => t0 + i * H);
    const gold = ts.map((_, i) => 4000 * Math.exp(0.002 * Math.sin(i / 3) + i * 0.0001));
    const chart = (vals: (number | null)[]) => ({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: vals }] } }], error: null } });
    routes.push(
      [/chart\/GC%3DF/, chart(gold)],
      [/chart\/DX-Y\.NYB/, chart(gold.map((g, i) => (i === 10 ? null : 400000 / g)))],
      [/chart\//, chart(gold.map((g, i) => g * (1 + Math.cos(i * 7) * 0.01)))],
    );
    const { loadMacro } = await import("@/lib/server/macro");
    const m = await loadMacro("gold");
    const dxy = m.series.find((s) => s.id === "dxy")!;
    expect(dxy.corr30d).toBeLessThan(-0.99);
    expect(dxy.last).toBeCloseTo(400000 / gold.at(-1)!, 6);
    expect(m.series.find((s) => s.id === "us10y")!.chgBp24h).not.toBeUndefined();
    expect(m.cot).toBeNull();
  });
});
