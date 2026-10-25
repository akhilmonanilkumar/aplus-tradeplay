import type { ReactNode } from "react";

export function Icon({ d, className = "h-4 w-4" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function PageHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

export function Card({ title, right, children, className = "" }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card p-5 ${className}`}>
      {(title || right) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, tone, foot }: { label: string; value: ReactNode; tone?: string; foot?: ReactNode }) {
  return (
    <div className="card p-4 sm:p-5">
      <div className="label truncate">{label}</div>
      <div className={`num mt-2 truncate text-[20px] font-semibold leading-none sm:text-[28px] ${tone ?? ""}`}>{value}</div>
      {foot && <div className="mt-2 text-xs text-mute">{foot}</div>}
    </div>
  );
}

export function Row({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="text-mute">{k}</span>
      <span className={`num ${tone ?? ""}`}>{v}</span>
    </div>
  );
}

const BADGE: Record<string, string> = {
  up: "bg-up/15 text-up",
  down: "bg-down/15 text-down",
  warn: "bg-warn/15 text-warn",
  accent: "bg-accent/15 text-accent",
  chart: "bg-chart/15 text-chart",
  mute: "bg-raised text-mute",
};
export function Badge({ tone = "mute", children }: { tone?: keyof typeof BADGE | string; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${BADGE[tone] ?? BADGE.mute}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="grid place-items-center rounded-2xl border border-dashed border-line py-10 text-sm text-mute">{children}</div>;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left">
            {head.map((h, i) => (
              <th key={i} className={`label pb-2 font-medium ${i > 0 ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-t [&>tr]:border-line [&_td]:py-2.5 [&_td:not(:first-child)]:text-right">{children}</tbody>
      </table>
    </div>
  );
}

export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="label mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-full bg-raised p-1">
      {options.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)} className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${value === o.v ? "bg-panel text-ink shadow" : "text-mute hover:text-ink"}`}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="mb-4 rounded-xl bg-down/10 px-3 py-2 text-sm text-down">{error}</div>;
}

/** Simple bar list — label · bar · value. */
export function Bars({ items, tone = "bg-accent" }: { items: { label: string; value: number; display?: string }[]; tone?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-2.5">
      {items.map((i) => (
        <div key={i.label} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-mute">{i.label}</span>
          <div className="h-2 rounded-full bg-raised">
            <div className={`h-2 rounded-full ${tone}`} style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
          <span className="num whitespace-nowrap text-right">{i.display ?? i.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Equity curve sparkline drawn from cumulative values. */
export function Spark({ values, height = 120 }: { values: number[]; height?: number }) {
  if (values.length < 2) return <Empty>No closed trades yet</Empty>;
  const w = 600;
  const min = Math.min(...values, 0), max = Math.max(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, height - ((v - min) / span) * (height - 8) - 4] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const zero = height - ((0 - min) / span) * (height - 8) - 4;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="h-auto w-full" preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <line x1="0" x2={w} y1={zero} y2={zero} stroke="rgb(var(--line))" strokeDasharray="4 4" />
      <path d={`${d} L${w},${height} L0,${height} Z`} fill="rgb(var(--chart) / 0.12)" />
      <path d={d} fill="none" stroke="rgb(var(--chart))" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
