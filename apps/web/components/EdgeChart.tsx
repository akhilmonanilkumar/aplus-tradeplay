"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries, ColorType, HistogramSeries, LineStyle, createChart, createSeriesMarkers,
  type IChartApi, type ISeriesApi, type SeriesMarker, type Time, type UTCTimestamp,
} from "lightweight-charts";
import { EDGE_WINDOWS, isInWindow, type Candle } from "@aplus/engine";
import type { Analysis } from "@/lib/analyze";

export type Overlay = "sessions" | "pd" | "pois" | "liq" | "struct" | "pos";
export const OVERLAYS: { id: Overlay; l: string }[] = [
  { id: "sessions", l: "Sessions" },
  { id: "pd", l: "Premium / discount" },
  { id: "pois", l: "POIs" },
  { id: "liq", l: "Liquidity" },
  { id: "struct", l: "Structure" },
  { id: "pos", l: "Position" },
];

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const ts = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export default function EdgeChart({ candles, analysis, show, plan, side, height = 540 }: {
  candles: Candle[];
  analysis: Analysis | null;
  show: Record<Overlay, boolean>;
  plan: { entry: number; stop: number; target: number } | null;
  side: "long" | "short";
  height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const sess = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markers = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);

  // create once
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: css("--surface") }, textColor: css("--faint"), fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--line") },
      timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    sess.current = c.addSeries(HistogramSeries, { priceScaleId: "sess", color: css("--info-bg"), priceLineVisible: false, lastValueVisible: false });
    c.priceScale("sess").applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: css("--up"), downColor: css("--down"), wickUpColor: css("--up"), wickDownColor: css("--down"), borderVisible: false,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    markers.current = createSeriesMarkers(series.current, []);
    chart.current = c;
    // follow theme changes (class on <html>)
    const mo = new MutationObserver(() => {
      c.applyOptions({ layout: { background: { type: ColorType.Solid, color: css("--surface") }, textColor: css("--faint") }, grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } } });
      series.current?.applyOptions({ upColor: css("--up"), downColor: css("--down"), wickUpColor: css("--up"), wickDownColor: css("--down") });
      sess.current?.applyOptions({ color: css("--info-bg") });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { mo.disconnect(); c.remove(); chart.current = null; series.current = null; sess.current = null; markers.current = null; };
  }, []);

  // data + overlays
  useEffect(() => {
    const s = series.current, h = sess.current;
    if (!s || !h) return;
    s.setData(candles.map((c) => ({ time: ts(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    h.setData(show.sessions ? candles.map((c) => ({ time: ts(c.t), value: EDGE_WINDOWS.some((w) => isInWindow(c.t, w)) ? 1 : 0 })) : []);
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
        line(z.top, col, `${z.label} top`, LineStyle.Solid);
        line(z.bottom, col, `${z.label} bottom`, LineStyle.Solid);
      }
    }
    if (a && show.liq) {
      if (a.pdh !== null) line(a.pdh, css("--warn"), "PDH");
      if (a.pdl !== null) line(a.pdl, css("--warn"), "PDL");
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
    if (a?.sweep && show.liq) marks.push({ time: ts(a.sweep.t), position: side === "long" ? "belowBar" : "aboveBar", color: css("--warn"), shape: side === "long" ? "arrowUp" : "arrowDown", text: `SWEEP ${a.sweep.label}` });
    if (a?.shift?.t && show.struct) marks.push({ time: ts(a.shift.t), position: side === "long" ? "aboveBar" : "belowBar", color: css("--text"), shape: "circle", text: "MSS" });
    marks.sort((x, y) => Number(x.time) - Number(y.time));
    markers.current?.setMarkers(marks);
  }, [candles, analysis, show, plan, side]);

  return <div ref={el} style={{ position: "relative", height, width: "100%" }} />;
}
