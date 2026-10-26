import "server-only";
import { cached, errMsg, getJson, getText } from "@/lib/server/http";

/* ---------------- headlines ---------------- */

export interface Headline { id: string; title: string; url: string; source: string; at: number; tone: "bullish" | "bearish" | "neutral"; feed: string }

const gnews = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const FEEDS: Record<"gold" | "btc", { name: string; url: string }[]> = {
  gold: [
    { name: "Gold", url: gnews('("gold price" OR XAUUSD OR "spot gold" OR bullion) when:2d') },
    { name: "Fed & dollar", url: gnews('("Federal Reserve" OR "Treasury yields" OR "US dollar" OR "rate cut") when:1d') },
    { name: "FXStreet", url: "https://www.fxstreet.com/rss/news" },
  ],
  btc: [
    { name: "Bitcoin", url: gnews("(bitcoin OR BTC) (price OR ETF OR futures) when:1d") },
    { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
    { name: "Cointelegraph", url: "https://cointelegraph.com/rss/tag/bitcoin" },
  ],
};

/** Keyword pass for a first read; the desk's AI analyst gives the considered view. */
const BULL = /\b(surge|soar|rall(y|ies)|jump|record high|all-time high|gain|climb|bull|inflow|rebound|rate cut|dovish|safe[- ]haven demand)\w*/i;
const BEAR = /\b(plunge|slump|tumble|drop|fall|slide|sell-?off|bear|outflow|crash|hawkish|rate hike|liquidat)\w*/i;

const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).trim();

function parseRss(xml: string, feed: string): Headline[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/g) ?? [];
  return items.map((it) => {
    const tag = (t: string) => decode(it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "");
    let title = tag("title");
    let source = tag("source") || feed;
    // Google News appends " - Publisher" to titles.
    const m = title.match(/^(.*) - ([^-]{2,60})$/);
    if (m && feed !== "FXStreet" && feed !== "CoinDesk" && feed !== "Cointelegraph") { title = m[1]!; source = m[2]!; }
    const url = tag("link");
    const at = Date.parse(tag("pubDate")) || Date.now();
    const tone: Headline["tone"] = BULL.test(title) && !BEAR.test(title) ? "bullish" : BEAR.test(title) && !BULL.test(title) ? "bearish" : "neutral";
    return { id: `${feed}:${url || title}`, title, url, source, at, tone, feed };
  }).filter((h) => h.title);
}

export function loadHeadlines(desk: "gold" | "btc"): Promise<{ items: Headline[]; errors: string[] }> {
  return cached(`n:${desk}`, 5 * 60_000, async () => {
    const errors: string[] = [];
    const lists = await Promise.all(FEEDS[desk].map(async (f) => {
      try { return parseRss(await getText(f.url), f.name); } catch (e) { errors.push(`${f.name}: ${errMsg(e)}`); return []; }
    }));
    const finnhub = process.env.FINNHUB_API_KEY?.trim();
    if (finnhub) {
      try {
        const rows = await getJson<{ id: number; headline: string; url: string; source: string; datetime: number }[]>(`https://finnhub.io/api/v1/news?category=${desk === "btc" ? "crypto" : "forex"}&token=${finnhub}`);
        lists.push(rows.filter((r) => desk === "btc" || /gold|xau|fed|dollar|yield|treasur/i.test(r.headline)).map((r) => ({ id: `fh:${r.id}`, title: r.headline, url: r.url, source: r.source, at: r.datetime * 1000, tone: "neutral" as const, feed: "Finnhub" })));
      } catch (e) { errors.push(`Finnhub: ${errMsg(e)}`); }
    }
    const seen = new Set<string>();
    const items = lists.flat()
      .filter((h) => Date.now() - h.at < 3 * 86_400_000)
      .sort((a, b) => b.at - a.at)
      .filter((h) => { const k = h.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 40);
    return { items, errors };
  });
}

/* ---------------- economic calendar ---------------- */

export interface CalEvent { id: string; at: number; currency: string; title: string; impact: "high" | "medium" | "low" | "holiday"; forecast: string | null; previous: string | null; desks: ("gold" | "btc")[] }

/** Forex Factory weekly export (this week + next week once published). */
export function loadCalendar(): Promise<{ items: CalEvent[]; errors: string[]; source: string }> {
  return cached("cal", 30 * 60_000, async () => {
    const errors: string[] = [];
    const weeks = await Promise.all(["thisweek", "nextweek"].map(async (w) => {
      try {
        return await getJson<{ title: string; country: string; date: string; impact: string; forecast: string; previous: string }[]>(`https://nfs.faireconomy.media/ff_calendar_${w}.json`);
      } catch (e) {
        if (w === "thisweek") errors.push(`Forex Factory: ${errMsg(e)}`);
        return [];
      }
    }));
    const items: CalEvent[] = weeks.flat().map((e) => {
      const impact = (e.impact || "").toLowerCase() as CalEvent["impact"];
      const ccy = e.country.toUpperCase();
      // USD data moves both desks; CNY/EUR high-impact also moves gold.
      const desks: CalEvent["desks"] = ccy === "USD" || ccy === "ALL" ? ["gold", "btc"] : ["CNY", "EUR"].includes(ccy) && impact === "high" ? ["gold"] : [];
      return { id: `${ccy}:${e.date}:${e.title}`, at: Date.parse(e.date), currency: ccy, title: e.title, impact, forecast: e.forecast || null, previous: e.previous || null, desks };
    }).filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
    return { items, errors, source: "Forex Factory" };
  });
}
