/**
 * Session windows anchored to America/New_York wall-clock time.
 * All conversion goes through IANA time zones (Intl), so DST changes
 * in New York, London or anywhere else are handled automatically.
 */

export const NY = 'America/New_York';
export const IST = 'Asia/Kolkata';
export const UTC = 'UTC';

export interface WallTime {
  hour: number;
  minute: number;
}

export interface SessionWindow {
  id: string;
  name: string;
  start: WallTime;
  end: WallTime;
  tz: string;
}

export const LONDON_Q: SessionWindow = { id: 'london_q', name: 'London Q', start: { hour: 2, minute: 0 }, end: { hour: 5, minute: 0 }, tz: NY };
export const NY_Q: SessionWindow = { id: 'ny_q', name: 'NY Q', start: { hour: 7, minute: 0 }, end: { hour: 10, minute: 0 }, tz: NY };
export const EDGE_WINDOWS = [LONDON_Q, NY_Q] as const;
/** Reference windows (not trade windows): Asia builds the range London sweeps; London close retraces. */
export const ASIA_Q: SessionWindow = { id: 'asia_q', name: 'Asia', start: { hour: 20, minute: 0 }, end: { hour: 24, minute: 0 }, tz: NY };
export const LONDON_CLOSE: SessionWindow = { id: 'london_close', name: 'London close', start: { hour: 10, minute: 0 }, end: { hour: 12, minute: 0 }, tz: NY };
export const ALL_WINDOWS = [ASIA_Q, LONDON_Q, NY_Q, LONDON_CLOSE] as const;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(ts: number, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ts))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday ?? '',
  };
}

/** Offset of `tz` from UTC at instant `ts`, in minutes (e.g. +330 for IST). */
export function tzOffsetMinutes(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60000);
}

/** UTC instant for a wall-clock time on a calendar date in `tz`. */
export function wallToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffsetMinutes(guess, tz);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(t, tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return t;
}

export function hhmm(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export interface WindowInstance {
  window: SessionWindow;
  startUtc: number;
  endUtc: number;
  /** Weekday in the window's own time zone, e.g. "Mon". */
  weekday: string;
}

/** The window on the calendar date (in the window's tz) that contains `ts`. */
export function windowOnDateOf(ts: number, w: SessionWindow): WindowInstance {
  const p = zonedParts(ts, w.tz);
  return {
    window: w,
    startUtc: wallToUtc(p.year, p.month, p.day, w.start.hour, w.start.minute, w.tz),
    endUtc: wallToUtc(p.year, p.month, p.day, w.end.hour, w.end.minute, w.tz),
    weekday: p.weekday,
  };
}

const WEEKEND = new Set(['Sat', 'Sun']);

/** Current window if live, otherwise the next weekday window. */
export function currentOrNextWindow(now: number, w: SessionWindow): WindowInstance & { live: boolean } {
  for (let k = 0; k < 8; k++) {
    const inst = windowOnDateOf(now + k * 86_400_000, w);
    if (WEEKEND.has(inst.weekday)) continue;
    if (inst.endUtc > now) return { ...inst, live: inst.startUtc <= now };
  }
  throw new Error('no window found within 8 days');
}

export function isInWindow(now: number, w: SessionWindow): boolean {
  const inst = windowOnDateOf(now, w);
  return !WEEKEND.has(inst.weekday) && inst.startUtc <= now && now < inst.endUtc;
}

/** Forex/CFD weekend: Friday 17:00 ET to Sunday 17:00 ET (gold). Crypto trades 24/7. */
export function isFxWeekend(now: number): boolean {
  const p = zonedParts(now, NY);
  if (p.weekday === 'Sat') return true;
  if (p.weekday === 'Sun') return p.hour < 17;
  if (p.weekday === 'Fri') return p.hour >= 17;
  return false;
}

/**
 * Spot gold / FX CFD closed: the weekend (Fri 17:00 → Sun 17:00 New York) and the
 * daily 17:00–18:00 New York maintenance break. Vendors that print bars while the
 * market is shut fill them with stale quotes; those bars must not reach the engine.
 */
export function isFxClosed(t: number): boolean {
  if (isFxWeekend(t)) return true;
  const p = zonedParts(t, NY);
  return p.hour === 17 && p.weekday !== 'Sat';
}
