export const money = (v: number | null | undefined, ccy = "USD", digits = 2) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const sym = ccy === "INR" ? "₹" : ccy === "USD" || ccy === "USDT" ? "$" : "";
  const s = Math.abs(v).toLocaleString(ccy === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v < 0 ? "−" : ""}${sym}${s}${sym ? "" : ` ${ccy}`}`;
};

export const num = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const r = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}R`;

export const pct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

export const signed = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-mute");

export const dateShort = (iso: string | null | undefined, tz = "Asia/Kolkata") =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: tz }) : "—";

export const timeShort = (ts: number, tz: string) =>
  new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });

export const toNum = (s: string) => {
  const v = Number(String(s).replace(/,/g, "").trim());
  return Number.isFinite(v) ? v : NaN;
};
