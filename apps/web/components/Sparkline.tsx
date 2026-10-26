/** Tiny inline line chart for tables and stat tiles. */
export default function Sparkline({ values, width = 96, height = 26, tone = "var(--chart)", zero = false }: { values: number[]; width?: number; height?: number; tone?: string; zero?: boolean }) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;
  const lo = Math.min(...values, ...(zero ? [0] : [])), hi = Math.max(...values, ...(zero ? [0] : []));
  const span = hi - lo || 1;
  const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4);
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * width).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: "block" }}>
      {zero && lo < 0 && hi > 0 && <line x1="0" x2={width} y1={y(0)} y2={y(0)} stroke="var(--line-2)" strokeDasharray="2 2" />}
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
