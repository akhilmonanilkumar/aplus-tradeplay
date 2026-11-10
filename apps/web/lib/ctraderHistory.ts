/**
 * cTrader history files → closed trades. Reads the History tab export (CSV, semicolon or tab separated,
 * from cTrader Desktop, Web or a statement), whatever columns are switched on: it finds the columns by
 * name, takes the time zone from the header ("Opening time (UTC+5:30)"), and accepts the usual date and
 * number formats. Also the helpers both importers share: is this the same trade as one already in the
 * journal, and which logged setup did a trade come from.
 */

/** Broker symbol → our market id (the reverse of the alert mapping). */
export const fromCTraderSymbol = (s: string) => {
  const u = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (u.startsWith("XAUUSD") || u.startsWith("GOLD")) return "XAUUSD";
  if (u.startsWith("BTCUSD") || u.startsWith("BITCOIN")) return "BTCUSD";
  if (/^(US500|SPX|SP500|USA500)/.test(u)) return "SPX500";
  if (/^(NAS100|USTEC|US100|NDX|NQ100)/.test(u)) return "NAS100";
  for (const id of ["EURUSD", "GBPUSD", "USDJPY"]) if (u.startsWith(id)) return id;
  return s;
};

export interface HistRow {
  ref: string | null; symbol: string; side: "long" | "short"; qty: number; entry: number; exit: number;
  openedAt: number; closedAt: number; pnl: number | null; fees: number | null; sl: number | null; tp: number | null; comment: string | null;
}
export interface ParsedHistory { rows: HistRow[]; skipped: number; errors: string[]; columns: string[] }

type Col = "ref" | "order" | "symbol" | "side" | "open" | "close" | "entry" | "exit" | "qty" | "net" | "gross" | "commission" | "swap" | "sl" | "tp" | "comment";

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

/** Header name (normalised) → field. The first match wins, so the specific names come first. */
const NAMES: [Col, RegExp][] = [
  ["ref", /^(position id|position|id|ticket|deal id)$/],
  ["order", /^order id$/],
  ["symbol", /^(symbol|instrument|market)$/],
  ["side", /^(opening direction|direction|side|type|trade side)$/],
  ["open", /^(opening time|open time|entry time|opened)$/],
  ["close", /^(closing time|close time|exit time|closed)$/],
  ["entry", /^(entry price|opening price|open price)$/],
  ["exit", /^(closing price|close price|exit price)$/],
  ["qty", /^(closing quantity|quantity|volume|lots|closing volume|size)$/],
  ["net", /^(net|net realised|net profit|net usd|net p l)$/],
  ["gross", /^(gross|gross profit|gross usd|profit)$/],
  ["commission", /^(commission|commissions)$/],
  ["swap", /^(swap|swaps)$/],
  ["sl", /^(stop loss|sl)$/],
  ["tp", /^(take profit|tp)$/],
  ["comment", /^(comment|label)$/],
];

function splitLine(line: string, d: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** "1,234.56", "1 234,56", "-12.3 USD", "0.50 Lots" → number. `comma` says a lone comma is the decimal mark. */
export function parseNum(s: string | undefined, comma = false): number | null {
  if (!s) return null;
  let t = s.replace(/[\s  ]/g, "").replace(/[^0-9.,\-−]/g, "").replace("−", "-");
  if (!/[0-9]/.test(t)) return null;
  const lc = t.lastIndexOf(","), ld = t.lastIndexOf(".");
  if (lc >= 0 && ld >= 0) t = lc > ld ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (lc >= 0) t = comma ? t.replace(",", ".") : t.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "(UTC+5:30)", "(UTC-3)", "(GMT+1)" in a header → minutes east of UTC. */
export function zoneOf(header: string): number {
  const m = header.match(/(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** dd/MM/yyyy, dd.MM.yyyy, yyyy-MM-dd, yyyy.MM.dd (MM/dd when the first part cannot be a day) + HH:mm[:ss[.fff]], in a fixed offset. */
export function parseTime(s: string | undefined, offsetMin: number): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?/);
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  let y: number, mo: number, d: number;
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
  if (m[1]!.length === 4) { y = a; mo = b; d = c; }
  else { y = c < 100 ? 2000 + c : c; if (b > 12) { mo = a; d = b; } else { d = a; mo = b; } }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Number((m[7] ?? "0").padEnd(3, "0"));
  return Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6] ?? 0), ms) - offsetMin * 60_000;
}

export function parseCTraderHistory(text: string): ParsedHistory {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const errors: string[] = [];
  // The header is the first line that names a symbol and an opening or closing time.
  let hi = -1, delim = ",";
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const l = lines[i]!.toLowerCase();
    if (!/symbol/.test(l) || !/(open|clos)/.test(l)) continue;
    delim = [",", ";", "\t"].sort((x, y) => l.split(y).length - l.split(x).length)[0]!;
    hi = i; break;
  }
  if (hi < 0) return { rows: [], skipped: 0, errors: ["No header row with Symbol and Opening / Closing time columns"], columns: [] };
  const header = splitLine(lines[hi]!, delim);
  const idx = new Map<Col, number>();
  const zone: Partial<Record<Col, number>> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    const hit = NAMES.find(([, re]) => re.test(n));
    if (hit && !idx.has(hit[0])) { idx.set(hit[0], i); if (hit[0] === "open" || hit[0] === "close") zone[hit[0]] = zoneOf(h); }
  });
  for (const need of ["symbol", "side", "close", "entry", "exit"] as Col[]) if (!idx.has(need)) errors.push(`Missing a column for ${need === "side" ? "direction" : need === "close" ? "closing time" : need === "exit" ? "closing price" : need}`);
  if (errors.length) return { rows: [], skipped: 0, errors, columns: header };
  const comma = delim !== ",";
  const rows: HistRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(hi + 1)) {
    const f = splitLine(line, delim);
    const g = (c: Col) => (idx.has(c) ? f[idx.get(c)!] : undefined);
    const dir = (g("side") ?? "").toLowerCase();
    const side = /^(buy|long|b)\b/.test(dir) ? "long" : /^(sell|short|s)\b/.test(dir) ? "short" : null;
    const symbol = (g("symbol") ?? "").trim();
    const entry = parseNum(g("entry"), comma), exit = parseNum(g("exit"), comma);
    const closedAt = parseTime(g("close"), zone.close ?? 0);
    const openedAt = parseTime(g("open"), zone.open ?? zone.close ?? 0) ?? closedAt;
    if (!side || !symbol || entry === null || exit === null || closedAt === null || openedAt === null || !(entry > 0) || !(exit > 0)) { skipped++; continue; }
    const commission = parseNum(g("commission"), comma), swap = parseNum(g("swap"), comma);
    const gross = parseNum(g("gross"), comma), net = parseNum(g("net"), comma);
    const costs = (commission ?? 0) + (swap ?? 0);
    const sl = parseNum(g("sl"), comma), tp = parseNum(g("tp"), comma);
    rows.push({
      ref: (g("ref") || g("order") || "").trim() || null, symbol, side, qty: Math.abs(parseNum(g("qty"), comma) ?? 0), entry, exit, openedAt, closedAt,
      pnl: net ?? (gross !== null ? gross + costs : null), fees: commission !== null || swap !== null ? Math.round(-costs * 1e4) / 1e4 : null,
      sl: sl && sl > 0 ? sl : null, tp: tp && tp > 0 ? tp : null, comment: (g("comment") ?? "").trim() || null,
    });
  }
  return { rows, skipped, errors, columns: header };
}

/** Same trade already in the journal (another import, or the API sync): same market and side, closed within two minutes at the same price. */
export function isSameTrade(a: { instrument: string; side: string; closedAt: number; exit: number }, b: { instrument: string; side: string; closedAt: number; exit: number }) {
  return a.instrument === b.instrument && a.side === b.side && Math.abs(a.closedAt - b.closedAt) <= 120_000 && Math.abs(a.exit - b.exit) <= Math.max(a.exit, b.exit) * 5e-4;
}

export interface LoggedSetup { id: string; instrument: string; side: string; model: string | null; entry: number; stop: number; target: number; createdAt: number; strategy: string | null }

/**
 * The logged setup a trade was taken from: same market and side, opened between one minute before the
 * setup and eight hours after it, at an entry within a third of the setup's risk. Closest entry wins.
 */
export function matchSetup(t: { instrument: string; side: string; entry: number; openedAt: number }, setups: readonly LoggedSetup[]): LoggedSetup | null {
  let best: LoggedSetup | null = null, bestD = Infinity;
  for (const s of setups) {
    if (s.instrument !== t.instrument || s.side !== t.side) continue;
    if (t.openedAt < s.createdAt - 60_000 || t.openedAt > s.createdAt + 8 * 3_600_000) continue;
    const risk = Math.abs(s.entry - s.stop);
    const d = Math.abs(t.entry - s.entry);
    if (!(risk > 0) || d > risk / 3) continue;
    const score = d / risk + (Math.abs(t.openedAt - s.createdAt) / 3_600_000) * 0.02;
    if (score < bestD) { bestD = score; best = s; }
  }
  return best;
}
