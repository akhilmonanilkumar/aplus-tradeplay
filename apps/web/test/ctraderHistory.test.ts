import { describe, expect, it } from "vitest";
import { isSameTrade, matchSetup, parseCTraderHistory, parseNum, parseTime, zoneOf } from "@/lib/ctraderHistory";

const CSV = `ID,Order ID,Symbol,Opening Direction,Closing Direction,Opening Time (UTC+5:30),Closing Time (UTC+5:30),Entry Price,Closing Price,Closing Quantity,Closing volume,Gross $,Commission,Swap,Net $,Balance,Pips,Comment
12345678,98765,XAUUSD,Buy,Sell,05/11/2026 14:32:10.123,05/11/2026 16:01:00.000,"2,650.10","2,661.30",0.50 Lots,50 Ounces,560.00,-3.50,0.00,556.50,"100,556.50",112,APLUS 1a2b3c4d
12345679,98766,US500,Sell,Buy,06/11/2026 19:00:00.000,06/11/2026 19:40:00.000,5900.5,5910.5,1.00 Lots,1 Indices,-10.00,-0.50,-0.10,-10.60,"100,545.90",-100,
bad row,,,,,,,,,,,,,,,,,`;

describe("cTrader history file", () => {
  it("reads the History export with the zone from the header", () => {
    const p = parseCTraderHistory(CSV);
    expect(p.errors).toEqual([]);
    expect(p.skipped).toBe(1);
    expect(p.rows).toHaveLength(2);
    const [a, b] = p.rows;
    expect(a).toMatchObject({ ref: "12345678", symbol: "XAUUSD", side: "long", qty: 0.5, entry: 2650.1, exit: 2661.3, pnl: 556.5, fees: 3.5, sl: null, comment: "APLUS 1a2b3c4d" });
    expect(a!.openedAt).toBe(Date.UTC(2026, 10, 5, 9, 2, 10, 123));
    expect(b).toMatchObject({ symbol: "US500", side: "short", pnl: -10.6, fees: 0.6 });
  });
  it("reads semicolon files with decimal commas and dotted dates", () => {
    const p = parseCTraderHistory(`Symbol;Direction;Open time;Close time;Entry price;Close price;Volume;Net\nEURUSD;Sell;2026.11.03 08:15;2026.11.03 09:00;1,08512;1,08402;1 000 000;110,00`);
    expect(p.rows[0]).toMatchObject({ symbol: "EURUSD", side: "short", entry: 1.08512, exit: 1.08402, qty: 1_000_000, pnl: 110 });
    expect(p.rows[0]!.closedAt).toBe(Date.UTC(2026, 10, 3, 9, 0));
  });
  it("says what is missing when the file is not a history export", () => {
    expect(parseCTraderHistory("Date,Amount\n1,2").errors[0]).toMatch(/No header row/);
    expect(parseCTraderHistory("Symbol,Opening time,Entry price\nXAUUSD,01/01/2026 10:00,1").errors.join()).toMatch(/direction/);
  });
  it("numbers, zones and dates", () => {
    expect(parseNum("1 234,56", true)).toBe(1234.56);
    expect(parseNum("-12.3 USD")).toBe(-12.3);
    expect(parseNum("—")).toBeNull();
    expect(zoneOf("Opening time (UTC-3)")).toBe(-180);
    expect(parseTime("11/25/2026 10:00:00", 0)).toBe(Date.UTC(2026, 10, 25, 10));
    expect(parseTime("2026-11-25 10:00", 60)).toBe(Date.UTC(2026, 10, 25, 9));
  });
});

describe("trade matching", () => {
  const t0 = Date.UTC(2026, 10, 5, 9, 0);
  it("the same trade from a file and from the API is one trade", () => {
    expect(isSameTrade({ instrument: "XAUUSD", side: "long", closedAt: t0, exit: 2661.3 }, { instrument: "XAUUSD", side: "long", closedAt: t0 + 30_000, exit: 2661.35 })).toBe(true);
    expect(isSameTrade({ instrument: "XAUUSD", side: "long", closedAt: t0, exit: 2661.3 }, { instrument: "XAUUSD", side: "long", closedAt: t0 + 600_000, exit: 2661.3 })).toBe(false);
  });
  it("links a trade to the logged setup it was taken from", () => {
    const setups = [
      { id: "s1", instrument: "XAUUSD", side: "long", model: "S", entry: 2650, stop: 2644, target: 2668, createdAt: t0 - 30 * 60_000, strategy: "bnb-j" },
      { id: "s2", instrument: "XAUUSD", side: "long", model: "A", entry: 2655, stop: 2652, target: 2662, createdAt: t0 - 20 * 60_000, strategy: null },
      { id: "s3", instrument: "XAUUSD", side: "short", model: "B", entry: 2650.2, stop: 2654, target: 2640, createdAt: t0 - 10 * 60_000, strategy: null },
    ];
    expect(matchSetup({ instrument: "XAUUSD", side: "long", entry: 2650.4, openedAt: t0 }, setups)?.id).toBe("s1");
    expect(matchSetup({ instrument: "XAUUSD", side: "long", entry: 2640, openedAt: t0 }, setups)).toBeNull();
    expect(matchSetup({ instrument: "XAUUSD", side: "long", entry: 2650.4, openedAt: t0 + 9 * 3_600_000 }, setups)).toBeNull();
  });
});
