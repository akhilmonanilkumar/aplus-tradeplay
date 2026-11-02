/** Small SVG charts drawn to scale: one series, three faint gridlines, few labels. */

const label = { font: "11px var(--font-geist-mono), monospace" } as const;

export function LineChart({ vals, labels = [], color = "var(--accent)", h = 200, fill = true, zero = false, fmt = (v: number) => v.toFixed(0) }: {
  vals: number[]; labels?: string[]; color?: string; h?: number; fill?: boolean; zero?: boolean; fmt?: (v: number) => string;
}) {
  const W = 800, padR = 70, padB = labels.length ? 22 : 8, padT = 10;
  if (vals.length < 2) return <div className="empty" style={{ minHeight: h * 0.6 }}>Not enough data yet</div>;
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (zero) { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
  const rg = mx - mn || Math.abs(mx) * 0.01 || 1; mn -= rg * 0.08; mx += rg * 0.08;
  const X = (i: number) => (i / (vals.length - 1)) * (W - padR), Y = (v: number) => padT + ((mx - v) / (mx - mn)) * (h - padT - padB);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const base = Y(zero ? 0 : mn);
  const id = `lc${Math.abs(vals.length * 7919 + Math.round(vals[0]! * 13)) % 1e6}`;
  const step = Math.ceil(labels.length / 5);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} style={{ width: "100%", height: "auto", display: "block" }} role="img">
      <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".16" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {[0, 1, 2, 3].map((i) => { const v = mn + ((mx - mn) * i) / 3; return <g key={i}><line x1={0} x2={W - padR} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeDasharray="2 5" /><text x={W - padR + 10} y={Y(v) + 4} fill="var(--faint)" style={label}>{fmt(v)}</text></g>; })}
      {zero && <line x1={0} x2={W - padR} y1={Y(0)} y2={Y(0)} stroke="var(--line-2)" />}
      {labels.map((l, i) => (i % step === 0 && i < labels.length - step / 2 ? <text key={i} x={X(i)} y={h - 4} textAnchor="middle" fill="var(--faint)" style={label}>{l}</text> : null))}
      {fill && <path d={`${d} L${X(vals.length - 1)},${base} L0,${base} Z`} fill={`url(#${id})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={X(vals.length - 1)} cy={Y(vals.at(-1)!)} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

export function BarChart({ data, h = 200, fmt = (v: number) => v.toFixed(0) }: { data: { v: number; l?: string; c?: string }[]; h?: number; fmt?: (v: number) => string }) {
  const W = 800, padR = 70, padB = 22, padT = 10;
  if (!data.length) return <div className="empty" style={{ minHeight: h * 0.6 }}>No data</div>;
  const vals = data.map((d) => d.v);
  let mn = Math.min(0, ...vals), mx = Math.max(0, ...vals); const rg = mx - mn || 1; mx += rg * 0.08; if (mn < 0) mn -= rg * 0.08;
  const Y = (v: number) => padT + ((mx - v) / (mx - mn)) * (h - padT - padB), bw = (W - padR) / data.length, w = Math.min(bw * 0.56, 28);
  const step = Math.ceil(data.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${h}`} style={{ width: "100%", height: "auto", display: "block" }} role="img">
      {[0, 1, 2, 3].map((i) => { const v = mn + ((mx - mn) * i) / 3; return <g key={i}><line x1={0} x2={W - padR} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeDasharray="2 5" /><text x={W - padR + 10} y={Y(v) + 4} fill="var(--faint)" style={label}>{fmt(v)}</text></g>; })}
      {mn < 0 && <line x1={0} x2={W - padR} y1={Y(0)} y2={Y(0)} stroke="var(--line-2)" />}
      {data.map((d, i) => (
        <g key={i}>
          <rect x={i * bw + (bw - w) / 2} y={Math.min(Y(0), Y(d.v))} width={w} height={Math.max(1, Math.abs(Y(d.v) - Y(0)))} rx={3} fill={d.c ?? (d.v >= 0 ? "var(--up)" : "var(--down)")} />
          {d.l && i % step === 0 ? <text x={i * bw + bw / 2} y={h - 4} textAnchor="middle" fill="var(--faint)" style={label}>{d.l}</text> : null}
        </g>
      ))}
    </svg>
  );
}
