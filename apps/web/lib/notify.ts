/**
 * Notification categories, severities and default controls, shared by the bell, the settings page and
 * the server that writes and routes notifications.
 */

export const CATEGORIES = [
  { id: "headsup", label: "Heads-ups", what: "Proactive: news coming up, trades near stop or target, pre-session briefs" },
  { id: "setup", label: "Setups", what: "Autopilot states: swept, shifted, armed" },
  { id: "trade", label: "Trades & orders", what: "Orders queued or cancelled, trades opened and closed (paper and real)" },
  { id: "news", label: "News", what: "High-impact releases 30 minutes ahead" },
  { id: "feed", label: "Market feeds", what: "A market's feed down or stale while it is open" },
  { id: "basis", label: "Funding basis", what: "Basis positions opened, topped up, closed or liquidated" },
  { id: "account", label: "Money", what: "Payouts and cash flows" },
  { id: "system", label: "System", what: "Kill switch, execution mode, autopilot errors" },
] as const;

export type Category = (typeof CATEGORIES)[number]["id"];
export type Severity = "info" | "success" | "warn" | "critical";
export const SEVERITY_RANK: Record<Severity, number> = { info: 0, success: 1, warn: 2, critical: 3 };

export interface Notification {
  id: number; at: string; category: Category; severity: Severity; title: string; body: string | null;
  instrument: string | null; desk: string | null; link: string | null; meta: Record<string, unknown>;
}

export interface CategoryPrefs { bell: boolean; popup: boolean; sound: boolean }
export interface NotifyPrefs {
  cats: Record<Category, CategoryPrefs>;
  /** Pop-ups and sound only at or above this severity (the bell always lists everything enabled). */
  minSeverity: Severity;
  /** No pop-ups or sound in this IST window, except critical. */
  quiet: { on: boolean; from: string; to: string };
  mutedInstruments: string[];
}

const on = (popup: boolean, sound = false): CategoryPrefs => ({ bell: true, popup, sound });
export const DEFAULT_PREFS: NotifyPrefs = {
  cats: { headsup: on(true, true), setup: on(true), trade: on(true), news: on(true, true), feed: on(true), basis: on(true), account: on(false), system: on(true, true) },
  minSeverity: "info",
  quiet: { on: false, from: "23:00", to: "07:00" },
  mutedInstruments: [],
};

/** Merge stored preferences over the defaults (new categories get their defaults). */
export function prefsFrom(raw: unknown): NotifyPrefs {
  const p = (raw ?? {}) as Partial<NotifyPrefs>;
  return {
    cats: Object.fromEntries(CATEGORIES.map((c) => [c.id, { ...DEFAULT_PREFS.cats[c.id], ...(p.cats?.[c.id] ?? {}) }])) as NotifyPrefs["cats"],
    minSeverity: p.minSeverity ?? DEFAULT_PREFS.minSeverity,
    quiet: { ...DEFAULT_PREFS.quiet, ...(p.quiet ?? {}) },
    mutedInstruments: p.mutedInstruments ?? [],
  };
}

/** Telegram routing for the firm's chats (app_settings.integrations.notify). Setups and trades
 * already go out per market from the autopilot settings, so they are off here by default. */
export interface TelegramRouting { cats: Record<Category, boolean>; minSeverity: Severity }
export const DEFAULT_TELEGRAM: TelegramRouting = {
  cats: { headsup: true, setup: false, trade: false, news: true, feed: true, basis: true, account: true, system: true },
  minSeverity: "info",
};
export function telegramFrom(raw: unknown): TelegramRouting {
  const p = (raw ?? {}) as Partial<TelegramRouting>;
  return { cats: { ...DEFAULT_TELEGRAM.cats, ...(p.cats ?? {}) }, minSeverity: p.minSeverity ?? DEFAULT_TELEGRAM.minSeverity };
}

/** Is `now` inside an IST "HH:MM"–"HH:MM" window (which may wrap midnight)? */
export function inQuietHours(q: NotifyPrefs["quiet"], now = Date.now()): boolean {
  if (!q.on) return false;
  const ist = new Date(now + 330 * 60_000);
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const mins = (s: string) => { const [h, mm] = s.split(":").map(Number); return (h ?? 0) * 60 + (mm ?? 0); };
  const a = mins(q.from), b = mins(q.to);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

/** Should this notification pop up / play a sound for these preferences? */
export function shouldAlert(n: Pick<Notification, "category" | "severity" | "instrument">, p: NotifyPrefs, now = Date.now()) {
  const c = p.cats[n.category];
  if (!c?.bell || (n.instrument && p.mutedInstruments.includes(n.instrument))) return { popup: false, sound: false };
  const loudEnough = SEVERITY_RANK[n.severity] >= SEVERITY_RANK[p.minSeverity];
  const quiet = n.severity !== "critical" && inQuietHours(p.quiet, now);
  return { popup: c.popup && loudEnough && !quiet, sound: c.sound && loudEnough && !quiet };
}

export const deskOf = (i: string | null | undefined): string | null =>
  !i ? null : i.startsWith("XAU") ? "gold" : i.startsWith("BTC") ? "btc" : i === "EURUSD" || i === "USDJPY" ? "fx" : ["NAS100", "SPX500", "NIFTY"].includes(i) ? "indices" : null;
