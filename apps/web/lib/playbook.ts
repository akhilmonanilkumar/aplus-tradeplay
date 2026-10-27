import type { ModelId } from "@aplus/engine";
import type { Sketch } from "@/components/PlaybookChart";

/** Illustrations for the playbook cards (long versions; shorts are the mirror image). */
export const MODEL_SKETCH: Record<ModelId, Sketch> = {
  A: {
    closes: [80, 74, 77, 68, 71, 62, 64, 56, 58, 50, 52, 41, 36, 42, 49, 55, 61, 57, 52, 48, 56, 66, 77, 88, 98],
    wicks: { 12: { l: 26 }, 10: { h: 54 }, 19: { l: 46 } },
    zones: [{ x0: 10, x1: 13, y0: 28, y1: 38, label: "15M POI", tone: "poi", below: true }, { x0: 13, x1: 20, y0: 44, y1: 50, label: "5M OB", tone: "ob" }],
    lines: [{ y: 31, x0: 5, x1: 12, label: "liquidity", tone: "liq" }, { y: 54, x0: 8, x1: 16, label: "last LH", tone: "struct" }],
    marks: [{ x: 12, y: 26, label: "SWEEP", tone: "sweep" }, { x: 16, y: 61, label: "MSS", tone: "shift" }],
    plan: { x: 19, entry: 49, stop: 24, target: 98 },
  },
  B: {
    closes: [80, 74, 76, 67, 69, 60, 62, 52, 54, 44, 38, 46, 52, 49, 45, 51, 57, 62, 58, 55, 60, 70, 82, 96],
    wicks: { 10: { l: 32 }, 12: { h: 55 }, 19: { l: 53 } },
    zones: [{ x0: 8, x1: 11, y0: 32, y1: 42, label: "15M POI", tone: "poi", below: true }, { x0: 6, x1: 20, y0: 50, y1: 56, label: "supply → flip", tone: "flip" }],
    marks: [{ x: 10, y: 32, label: "SWEEP", tone: "sweep" }, { x: 17, y: 62, label: "BREAK", tone: "shift" }],
    plan: { x: 19, entry: 56, stop: 31, target: 96 },
  },
  C: {
    closes: [78, 72, 75, 66, 68, 58, 61, 50, 44, 46, 58, 68, 65, 60, 66, 75, 85, 95],
    wicks: { 8: { l: 34 }, 9: { h: 47.5 }, 11: { l: 57 }, 13: { l: 56.5 }, 6: { h: 62.5 } },
    zones: [{ x0: 3, x1: 9, y0: 36, y1: 46, label: "15M POI", tone: "poi", below: true }, { x0: 8, x1: 13, y0: 42, y1: 47.5, label: "OB", tone: "ob", below: true }, { x0: 10, x1: 15, y0: 47.5, y1: 57, label: "FVG", tone: "fvg" }],
    lines: [{ y: 62.5, x0: 6, x1: 11, label: "last LH", tone: "struct" }],
    marks: [{ x: 8, y: 34, label: "SWEEP", tone: "sweep" }, { x: 11, y: 68, label: "MSS", tone: "shift" }],
    plan: { x: 13, entry: 57, stop: 33, target: 95 },
  },
  D: {
    closes: [82, 76, 78, 70, 62, 55, 48, 56, 60, 57, 52, 46, 43, 50, 58, 64, 60, 56, 63, 72, 82, 92],
    wicks: { 6: { l: 44 }, 12: { l: 38 }, 8: { h: 61 }, 17: { l: 55 } },
    zones: [{ x0: 5, x1: 14, y0: 40, y1: 50, label: "15M POI · liquidity", tone: "poi", below: true }],
    lines: [{ y: 44, x0: 6, x1: 12, label: "first-tap low", tone: "liq" }, { y: 61, x0: 8, x1: 15, label: "last LH", tone: "struct" }],
    marks: [{ x: 6, y: 57, label: "1st TAP", tone: "entry" }, { x: 12, y: 38, label: "SWEEP", tone: "sweep" }, { x: 15, y: 64, label: "MSS", tone: "shift" }],
    plan: { x: 17, entry: 57, stop: 37, target: 92 },
  },
  E: {
    closes: [80, 74, 77, 68, 70, 61, 63, 54, 56, 47, 49, 44, 52, 58, 64, 70, 76, 82, 88],
    wicks: { 11: { l: 34 } },
    zones: [{ x0: 8, x1: 11, y0: 38, y1: 48, label: "15M POI", tone: "poi", below: true }],
    lines: [{ y: 40, x0: 3, x1: 11, label: "sell-side liquidity", tone: "liq" }],
    marks: [{ x: 11, y: 34, label: "SWEEP · enter at close", tone: "sweep" }],
    plan: { x: 11, entry: 44, stop: 32, target: 80 },
  },
  F: {
    closes: [56, 62, 58, 66, 60, 68, 63, 70, 61, 64, 57, 53, 51, 55, 61, 67, 62, 58, 64, 72, 80, 88],
    wicks: { 12: { l: 44 }, 9: { h: 65.5 }, 17: { l: 57 } },
    zones: [{ x0: 0, x1: 9, y0: 50, y1: 71.5, label: "Asia range", tone: "range" }],
    lines: [{ y: 65.5, x0: 9, x1: 15, label: "last LH", tone: "struct" }],
    marks: [{ x: 12, y: 44, label: "SWEEP Asia low", tone: "sweep" }, { x: 15, y: 67, label: "MSS", tone: "shift" }],
    plan: { x: 17, entry: 58, stop: 43, target: 88 },
  },
  G: {
    closes: [95, 89, 91, 83, 85, 76, 78, 69, 71, 62, 64, 55, 52, 57, 61, 67, 62, 56, 62, 67, 72],
    wicks: { 12: { l: 47 }, 10: { h: 65.5 }, 17: { l: 54.5 } },
    zones: [{ x0: 10, x1: 13, y0: 48, y1: 56, label: "POI", tone: "poi" }, { x0: 6, x1: 20, y0: 72, y1: 78, label: "nearest 5M zone = target", tone: "flip" }],
    lines: [{ y: 65.5, x0: 10, x1: 15, label: "last LH (1M)", tone: "struct" }],
    marks: [{ x: 12, y: 47, label: "SWEEP", tone: "sweep" }, { x: 15, y: 67, label: "MSS 1M", tone: "shift" }],
    plan: { x: 17, entry: 56, stop: 46, target: 72 },
  },
  H: {
    closes: [70, 64, 66, 58, 60, 52, 46, 54, 62, 70, 77, 74, 71, 73, 72, 78, 84, 90, 96],
    wicks: { 6: { l: 40 }, 12: { l: 69.5 }, 14: { l: 70.5 } },
    zones: [{ x0: 6, x1: 12, y0: 48, y1: 53, label: "5M OB · never filled", tone: "ob" }, { x0: 12, x1: 15, y0: 70, y1: 72.5, label: "1M OB", tone: "fvg", below: true }],
    marks: [{ x: 6, y: 40, label: "SWEEP", tone: "sweep" }, { x: 8, y: 62, label: "MSS", tone: "shift" }, { x: 13, y: 76, label: "1M BOS", tone: "shift" }],
    plan: { x: 14, entry: 72, stop: 69, target: 92 },
  },
  I: {
    closes: [60, 61, 59, 62, 74, 52, 56, 53, 57, 54, 58, 55, 53, 57, 60, 63, 59, 56, 62, 68, 74, 80],
    wicks: { 4: { h: 86 }, 5: { l: 44 }, 12: { l: 47 }, 10: { h: 58.5 } },
    zones: [{ x0: 6, x1: 11, y0: 50, y1: 60, label: "wait 30–120 min", tone: "range" }],
    lines: [{ y: 58.5, x0: 10, x1: 15, label: "last LH", tone: "struct" }],
    marks: [{ x: 4, y: 86, label: "NEWS", tone: "entry" }, { x: 12, y: 47, label: "SWEEP", tone: "sweep" }, { x: 15, y: 63, label: "MSS", tone: "shift" }],
    plan: { x: 17, entry: 56, stop: 45, target: 80 },
  },
};

/** Session-range strategies, by id in SESSION_STRATEGIES. */
export const STRATEGY_SKETCH: Record<string, Sketch> = {
  "asia-fade": {
    closes: [56, 62, 58, 66, 60, 68, 62, 69, 61, 64, 58, 54, 57, 60, 63, 61, 66, 71],
    wicks: { 12: { l: 44 } },
    zones: [{ x0: 0, x1: 9, y0: 50, y1: 71, label: "Asia range", tone: "range" }],
    marks: [{ x: 12, y: 44, label: "wick out, close back in", tone: "sweep" }],
    plan: { x: 12, entry: 57, stop: 43, target: 71 },
  },
  "asia-bo": {
    closes: [56, 62, 58, 66, 60, 68, 62, 69, 61, 64, 67, 76, 78, 75, 80, 86, 92, 98],
    zones: [{ x0: 0, x1: 9, y0: 50, y1: 71, label: "Asia range", tone: "range" }],
    lines: [{ y: 60.5, x0: 0, x1: 11, label: "range mid = stop", tone: "struct" }],
    marks: [{ x: 11, y: 79, label: "close beyond the high", tone: "entry" }],
    plan: { x: 11, entry: 76, stop: 60.5, target: 98 },
  },
  "ldn-fade": {
    closes: [40, 47, 43, 52, 46, 55, 48, 56, 49, 52, 46, 42, 45, 49, 52, 50, 54, 58],
    wicks: { 12: { l: 32 } },
    zones: [{ x0: 0, x1: 9, y0: 38, y1: 58, label: "London range", tone: "range" }],
    marks: [{ x: 12, y: 32, label: "wick out, close back in", tone: "sweep" }],
    plan: { x: 12, entry: 45, stop: 31, target: 58 },
  },
  "ldn-bo": {
    closes: [40, 47, 43, 52, 46, 55, 48, 56, 49, 52, 55, 63, 66, 62, 68, 74, 80, 86],
    zones: [{ x0: 0, x1: 9, y0: 38, y1: 58, label: "London range", tone: "range" }],
    lines: [{ y: 48, x0: 0, x1: 11, label: "range mid = stop", tone: "struct" }],
    marks: [{ x: 11, y: 66, label: "close beyond the high", tone: "entry" }],
    plan: { x: 11, entry: 63, stop: 48, target: 86 },
  },
};

/** What each session strategy does, step by step. */
export const STRATEGY_RULES: Record<string, { steps: string[]; entry: string; stop: string; target: string }> = {
  "asia-fade": {
    steps: ["Asia (20:00–24:00 New York) builds the range", "In London Q, a 5M candle wicks through a range edge and closes back inside", "One trade per New York day; flat at 16:00 New York"],
    entry: "Market, at that candle's close", stop: "Beyond the wick plus the spread buffer (at least 0.5 × 5M ATR)", target: "The opposite range edge (at least 1R)",
  },
  "asia-bo": {
    steps: ["Asia builds the range", "In London Q, the first 5M close beyond a range edge", "One trade per New York day; flat at 16:00 New York"],
    entry: "Market, at the breakout close", stop: "The middle of the Asia range (at least 0.5 × 5M ATR)", target: "2R (the 3R variant banks half at 1R)",
  },
  "ldn-fade": {
    steps: ["London Q (02:00–05:00 New York) builds the range", "In NY Q, a 5M candle wicks through a range edge and closes back inside", "One trade per New York day; flat at 16:00 New York"],
    entry: "Market, at that candle's close", stop: "Beyond the wick plus the spread buffer (at least 0.5 × 5M ATR)", target: "The opposite range edge (at least 1R)",
  },
  "ldn-bo": {
    steps: ["London Q builds the range", "In NY Q, the first 5M close beyond a range edge", "One trade per New York day; flat at 16:00 New York"],
    entry: "Market, at the breakout close", stop: "The middle of the London range (at least 0.5 × 5M ATR)", target: "2R (the 3R variant banks half at 1R)",
  },
};
