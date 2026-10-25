import type { CSSProperties, ReactNode } from "react";

export function Icon({ d, className = "h-4 w-4" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={d} />
    </svg>
  );
}

type Span = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12;

export function Card({ title, right, children, span, className = "", style, id }: { title?: ReactNode; right?: ReactNode; children: ReactNode; span?: Span; className?: string; style?: CSSProperties; id?: string }) {
  return (
    <section id={id} className={`card${span ? ` s${span}` : ""} ${className}`} style={style}>
      {(title || right) && (
        <div className="ch">
          {title && <h3>{title}</h3>}
          <span className="sp" />
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, tone = "", foot, span = 3, size = "lg" }: { label: ReactNode; value: ReactNode; tone?: string; foot?: ReactNode; span?: Span; size?: "lg" | "md" }) {
  return (
    <div className={`card s${span}`}>
      <div className="lbl">{label}</div>
      <div className={`kv ${size === "lg" ? "lg" : ""} ${tone}`} style={{ marginTop: 6 }}>{value}</div>
      {foot && <div className="row" style={{ marginTop: 4, fontSize: 12 }}>{foot}</div>}
    </div>
  );
}

export function Chip({ tone, dot, children }: { tone?: "up" | "down" | "warn" | "info" | "acc" | "solid" | ""; dot?: boolean; children: ReactNode }) {
  return <span className={`chip ${tone ?? ""}`}>{dot && <span className="dot" />}{children}</span>;
}

export function Row({ k, v, tone = "" }: { k: ReactNode; v: ReactNode; tone?: string }) {
  return (
    <div className="between" style={{ padding: "7px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
      <span className="muted">{k}</span>
      <span className={`mono ${tone}`} style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );
}

export function Field({ label, children, unit, className = "", txt = false }: { label: string; children: ReactNode; unit?: string; className?: string; txt?: boolean }) {
  return (
    <label className={`fld ${className}`}>
      <span>{label}</span>
      <div className={`inp${txt ? " txt" : ""}`}>{children}{unit && <span className="u">{unit}</span>}</div>
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { v: T; l: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" className={value === o.v ? "on" : ""} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>{o.l}</button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className={`tog${on ? " on" : ""}`} aria-pressed={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export function Table({ head, children, right = [] }: { head: ReactNode[]; children: ReactNode; right?: number[] }) {
  return (
    <div className="tbl-w">
      <table className="tbl">
        <thead><tr>{head.map((h, i) => <th key={i} className={right.includes(i) ? "r" : ""}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Bar({ pct, tone = "" }: { pct: number; tone?: "" | "up" | "down" | "warn" | "info" }) {
  return <div className={`bar ${tone}`}><i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div className="banner down"><span className="dot" />{error}</div>;
}

export function Note({ tone = "up", children }: { tone?: "up" | "warn" | "info" | "down"; children: ReactNode }) {
  return <div className={`banner ${tone}`}><span className="dot" />{children}</div>;
}

/** Equity curve from cumulative values (violet = the journal's curve colour). */
export function Spark({ values, height = 140, empty = "No closed trades yet" }: { values: number[]; height?: number; empty?: string }) {
  if (values.length < 2) return <Empty>{empty}</Empty>;
  const w = 600;
  const min = Math.min(...values, 0), max = Math.max(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, height - ((v - min) / span) * (height - 8) - 4] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const zero = height - ((0 - min) / span) * (height - 8) - 4;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} style={{ width: "100%", height }} preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <line x1="0" x2={w} y1={zero} y2={zero} stroke="var(--line-2)" strokeDasharray="4 4" />
      <path d={`${d} L${w},${height} L0,${height} Z`} fill="var(--chart)" opacity="0.12" />
      <path d={d} fill="none" stroke="var(--chart)" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Horizontal bars: label · bar · value. */
export function Bars({ items, tone = "" }: { items: { label: string; value: number; display?: string }[]; tone?: "" | "up" | "down" | "warn" | "info" }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="col" style={{ gap: 10 }}>
      {items.map((i) => (
        <div key={i.label} style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) auto", gap: 10, alignItems: "center", fontSize: 12.5 }}>
          <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.label}</span>
          <Bar pct={(i.value / max) * 100} tone={tone} />
          <span className="mono" style={{ minWidth: 48, textAlign: "right" }}>{i.display ?? i.value}</span>
        </div>
      ))}
    </div>
  );
}

/** One row of the 7-box A+ gate. */
export function GateRow({ n, label, reason, status }: { n: number; label: string; reason: string; status: "pass" | "warn" | "fail" | "pending" }) {
  const cls = status === "pass" ? "p" : status === "fail" ? "f" : status === "warn" ? "w" : "";
  const chip = status === "pass" ? <Chip tone="up">pass</Chip> : status === "fail" ? <Chip tone="down">fail</Chip> : status === "warn" ? <Chip tone="warn">soft</Chip> : <Chip>wait</Chip>;
  return (
    <div className="gate">
      <span className={`gi ${cls}`}>{n}</span>
      <div style={{ minWidth: 0 }}><b style={{ fontSize: 12.5 }}>{label}</b><div className="faint" style={{ fontSize: 11.5 }}>{reason}</div></div>
      {chip}
    </div>
  );
}

const STATES = ["IDLE", "PLANNED", "IN_POI", "SWEPT", "SHIFTED", "ARMED"] as const;
/** Copilot state rail (IDLE → ARMED). */
export function StateRail({ state }: { state: string }) {
  const idx = state === "FILLED" ? STATES.length : STATES.indexOf(state as (typeof STATES)[number]);
  return (
    <>
      <div className="rail" aria-label={`State: ${state}`}>
        {STATES.map((s, i) => <span key={s} className={i < idx ? "done" : i === idx ? "now" : ""} />)}
      </div>
      <div className="row faint mono" style={{ fontSize: 10.5, justifyContent: "space-between" }}>
        {STATES.map((s) => <span key={s}>{s}</span>)}
      </div>
    </>
  );
}
