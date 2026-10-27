/**
 * Schematic chart for a playbook card: candles built from a close series, with zones, levels and
 * markers drawn in price units (0–100, up is up). Long examples; shorts are the mirror image.
 */

export interface Sketch {
  /** Candle closes; each candle opens at the previous close. */
  closes: number[];
  /** Wick overrides by candle index: low (l) and/or high (h). */
  wicks?: Record<number, { l?: number; h?: number }>;
  zones?: { x0: number; x1: number; y0: number; y1: number; label: string; tone: "poi" | "ob" | "fvg" | "flip" | "range"; below?: boolean }[];
  lines?: { y: number; x0: number; x1: number; label: string; tone: "liq" | "struct" }[];
  marks?: { x: number; y: number; label: string; tone: "sweep" | "shift" | "entry" }[];
  plan?: { x: number; entry: number; stop: number; target: number };
}

const W = 320, H = 190, PAD = { l: 8, r: 40, t: 14, b: 18 };
// Theme tokens only, so the charts follow light and dark mode and the accent theme.
const ZONE: Record<string, string> = { poi: "var(--info-bg)", ob: "var(--accent-bg)", fvg: "var(--up-bg)", flip: "var(--down-bg)", range: "var(--surface-3)" };
const ZONE_EDGE: Record<string, string> = { poi: "var(--info)", ob: "var(--accent-ink)", fvg: "var(--up)", flip: "var(--down)", range: "var(--faint)" };

export default function PlaybookChart({ s, title }: { s: Sketch; title: string }) {
  const n = s.closes.length;
  const cw = (W - PAD.l - PAD.r) / n;
  const x = (i: number) => PAD.l + i * cw + cw / 2;
  const candles = s.closes.map((c, i) => {
    const o = i === 0 ? c + (s.closes[1]! > c ? -3 : 3) : s.closes[i - 1]!;
    const w = s.wicks?.[i] ?? {};
    return { o, c, h: w.h ?? Math.max(o, c) + 1.5, l: w.l ?? Math.min(o, c) - 1.5 };
  });
  // Fit the price scale to everything drawn, with room for labels above and below.
  const vals = [...candles.flatMap((k) => [k.h, k.l]), ...(s.zones ?? []).flatMap((z) => [z.y0, z.y1]), ...(s.plan ? [s.plan.stop, s.plan.target] : [])];
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.12;
  const y = (v: number) => PAD.t + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - PAD.t - PAD.b);
  const tag = (px: number, py: number, text: string, color: string, anchor: "start" | "end" | "middle" = "start") => (
    <text x={px} y={py} fill={color} fontSize={8.5} fontFamily="var(--font-geist-mono), ui-monospace, monospace" textAnchor={anchor} dominantBaseline="middle"
      stroke="var(--surface-2)" strokeWidth={3} paintOrder="stroke" strokeLinejoin="round">{text}</text>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} style={{ width: "100%", height: "auto", display: "block", background: "var(--surface-2)", borderRadius: 10 }}>
      {(s.zones ?? []).map((z, k) => (
        <g key={`z${k}`}>
          <rect x={x(z.x0) - cw / 2} y={y(z.y1)} width={(z.x1 - z.x0 + 1) * cw} height={Math.max(2, y(z.y0) - y(z.y1))} fill={ZONE[z.tone]} stroke={ZONE_EDGE[z.tone]} strokeOpacity={0.55} strokeDasharray={z.tone === "range" ? "3 3" : undefined} rx={2} />
          {tag(x(z.x0) - cw / 2 + 2, z.below ? y(z.y0) + 7 : y(z.y1) - 6, z.label, ZONE_EDGE[z.tone]!)}
        </g>
      ))}
      {(s.lines ?? []).map((l, k) => (
        <g key={`l${k}`}>
          <line x1={x(l.x0)} x2={x(l.x1)} y1={y(l.y)} y2={y(l.y)} stroke={l.tone === "liq" ? "var(--warn)" : "var(--text)"} strokeOpacity={l.tone === "liq" ? 0.9 : 0.55} strokeDasharray={l.tone === "liq" ? "2 3" : "5 3"} strokeWidth={1} />
          {tag(x(l.x0), y(l.y) - 6, l.label, l.tone === "liq" ? "var(--warn)" : "var(--muted)")}
        </g>
      ))}
      {candles.map((k, i) => {
        const up = k.c >= k.o;
        const col = up ? "var(--up)" : "var(--down)";
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(k.h)} y2={y(k.l)} stroke={col} strokeWidth={1} />
            <rect x={x(i) - cw * 0.32} width={cw * 0.64} y={y(Math.max(k.o, k.c))} height={Math.max(1.2, Math.abs(y(k.o) - y(k.c)))} fill={col} rx={1} />
          </g>
        );
      })}
      {s.plan && (() => {
        const p = s.plan, x0 = x(p.x) - cw / 2, x1 = W - PAD.r + 2;
        return (
          <g>
            <rect x={x0} y={y(p.target)} width={x1 - x0} height={y(p.entry) - y(p.target)} fill="var(--up)" opacity={0.08} />
            <rect x={x0} y={y(p.entry)} width={x1 - x0} height={y(p.stop) - y(p.entry)} fill="var(--down)" opacity={0.1} />
            {[{ v: p.target, l: "TP", c: "var(--up)" }, { v: p.entry, l: "LIMIT", c: "var(--accent-ink)" }, { v: p.stop, l: "SL", c: "var(--down)" }].map((r) => (
              <g key={r.l}>
                <line x1={x0} x2={x1} y1={y(r.v)} y2={y(r.v)} stroke={r.c} strokeWidth={1.2} strokeDasharray={r.l === "LIMIT" ? undefined : "4 3"} />
                {tag(x1 + 4, y(r.v), r.l, r.c)}
              </g>
            ))}
          </g>
        );
      })()}
      {(s.marks ?? []).map((m, k) => {
        const col = m.tone === "sweep" ? "var(--warn)" : m.tone === "shift" ? "var(--text)" : "var(--accent-ink)";
        const below = m.tone === "sweep";
        return (
          <g key={`m${k}`}>
            {m.tone === "shift" ? <circle cx={x(m.x)} cy={y(m.y)} r={3} fill="none" stroke={col} strokeWidth={1.4} /> : <path d={below ? `M${x(m.x)},${y(m.y) + 4} l-3.5,6 h7 z` : `M${x(m.x)},${y(m.y) - 4} l-3.5,-6 h7 z`} fill={col} />}
            {tag(x(m.x), below ? y(m.y) + 16 : y(m.y) - 14, m.label, col, "middle")}
          </g>
        );
      })}
    </svg>
  );
}
