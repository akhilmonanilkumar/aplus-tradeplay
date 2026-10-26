"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries, ColorType, HistogramSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { EDGE_WINDOWS, isInWindow, type Candle, type SetupAnalysis } from "@aplus/engine";

export type Overlay = "sessions" | "pd" | "pois" | "liq" | "struct" | "pos";
export const OVERLAYS: { id: Overlay; l: string }[] = [
  { id: "struct", l: "Structure" },
  { id: "liq", l: "Liquidity" },
  { id: "pois", l: "POIs" },
  { id: "pd", l: "Premium / discount" },
  { id: "sessions", l: "Sessions" },
  { id: "pos", l: "Position" },
];

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ts = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

/**
 * Engine chart: closed candles + a forming bar driven by live ticks, with the
 * detector's levels drawn on top. Overlays come from closed candles only, so they never repaint.
 */
export default function DeskChart({ candles, forming, tfMs, live, analysis, show, plan, side, digits = 2, markersOn = true, height = 520 }: {
  candles: Candle[];
  forming: Candle | null;
  tfMs: number;
  live: number | null;
  analysis: SetupAnalysis | null;
  show: Record<Overlay, boolean>;
  plan: { entry: number; stop: number; target: number } | null;
  side: "long" | "short";
  digits?: number;
  markersOn?: boolean;
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const sess = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markers = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const bar = useRef<Candle | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--surface") }, textColor: css("--faint"), fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--line") },
      timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: 0 },
      localization: { timeFormatter: (t: number) => new Date(t * 1000).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) },
    });
    sess.current = c.addSeries(HistogramSeries, { priceScaleId: "sess", color: css("--info-bg"), priceLineVisible: false, lastValueVisible: false });
    c.priceScale("sess").applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: css("--up"), downColor: css("--down"), wickUpColor: css("--up"), wickDownColor: css("--down"), borderVisible: false,
    });
    markers.current = createSeriesMarkers(series.current, []);
    chart.current = c;
    const mo = new MutationObserver(() => {
      c.applyOptions({ layout: { background: { type: ColorType.Solid, color: css("--surface") }, textColor: css("--faint") }, grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } } });
      series.current?.applyOptions({ upColor: css("--up"), downColor: css("--down"), wickUpColor: css("--up"), wickDownColor: css("--down") });
      sess.current?.applyOptions({ color: css("--info-bg") });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { mo.disconnect(); c.remove(); chart.current = null; series.current = null; sess.current = null; markers.current = null; };
  }, []);

  useEffect(() => {
    series.current?.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits } });
  }, [digits]);

  // data + overlays
  useEffect(() => {
    const s = series.current, h = sess.current;
    if (!s || !h) return;
    const rows = forming && (!candles.length || forming.t > candles[candles.length - 1]!.t) ? [...candles, forming] : candles;
    bar.current = forming ? { ...forming } : null;
    s.setData(rows.map((c) => ({ time: ts(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    h.setData(show.sessions ? rows.map((c) => ({ time: ts(c.t), value: EDGE_WINDOWS.some((w) => isInWindow(c.t, w)) ? 1 : 0 })) : []);
    if (!fitted.current && rows.length) { chart.current?.timeScale().scrollToRealTime(); fitted.current = true; }
    for (const pl of s.priceLines()) s.removePriceLine(pl);
    const line = (price: number, color: string, title: string, style = LineStyle.Dashed, width: 1 | 2 = 1) =>
      s.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title });
    const a = analysis;
    if (a && show.pd && a.range && a.eq !== null) {
      line(a.range.high, css("--faint"), "Range high", LineStyle.Dotted);
      line(a.eq, css("--muted"), "EQ 50%", LineStyle.Dotted);
      line(a.range.low, css("--faint"), "Range low", LineStyle.Dotted);
    }
    if (a && show.pois) {
      for (const z of a.zones.slice(0, 4)) {
        const col = side === "long" ? css("--up") : css("--down");
        line(z.top, col, `${z.label}`, LineStyle.Solid);
        line(z.bottom, col, "", LineStyle.Solid);
      }
    }
    if (a && show.liq) {
      for (const l of a.liquidity) line(l.level, css("--warn"), l.label, LineStyle.Dashed);
    }
    if (a && show.struct) {
      if (side === "long" && a.lastLH !== null) line(a.lastLH, css("--text"), "Last LH", LineStyle.Solid);
      if (side === "short" && a.lastHL !== null) line(a.lastHL, css("--text"), "Last HL", LineStyle.Solid);
    }
    if (plan && show.pos) {
      line(plan.target, css("--up"), "TP", LineStyle.Dashed, 2);
      line(plan.entry, css("--accent"), "LIMIT", LineStyle.Solid, 2);
      line(plan.stop, css("--down"), "SL", LineStyle.Dashed, 2);
    }
    const marks: SeriesMarker<Time>[] = [];
    if (markersOn && a?.sweep && show.liq) marks.push({ time: ts(a.sweep.t), position: side === "long" ? "belowBar" : "aboveBar", color: css("--warn"), shape: side === "long" ? "arrowUp" : "arrowDown", text: `SWEEP ${a.sweep.label}` });
    if (markersOn && a?.shift?.t && show.struct) marks.push({ time: ts(a.shift.t), position: side === "long" ? "aboveBar" : "belowBar", color: css("--text"), shape: "circle", text: "MSS" });
    marks.sort((x, y) => Number(x.time) - Number(y.time));
    markers.current?.setMarkers(marks);
  }, [candles, forming, analysis, show, plan, side, markersOn]);

  // live ticks move the forming bar (or open a new one at the boundary)
  useEffect(() => {
    const s = series.current;
    if (!s || live === null || !candles.length) return;
    const now = Date.now();
    const start = Math.floor(now / tfMs) * tfMs;
    const lastClosed = candles[candles.length - 1]!;
    if (start <= lastClosed.t) return;
    const b = bar.current && bar.current.t === start ? bar.current : { t: start, o: bar.current?.c ?? lastClosed.c, h: live, l: live, c: live };
    b.h = Math.max(b.h, live); b.l = Math.min(b.l, live); b.c = live;
    bar.current = b;
    s.update({ time: ts(b.t), open: b.o, high: b.h, low: b.l, close: b.c });
  }, [live, tfMs, candles]);

  return <div ref={el} style={{ position: "relative", height, width: "100%" }} />;
}
