import { NY, wallToUtc, zonedParts } from './sessions.js';

/**
 * High-impact US releases for backtests, where no historical calendar feed exists:
 * Non-Farm Payrolls (first Friday of the month, 08:30 New York) and FOMC statements
 * (14:00 New York on the Fed's published meeting dates). CPI and other releases move
 * from month to month and are not included, so a backtest's news filter is a floor.
 */

/** FOMC statement days (second day of each meeting). */
const FOMC: readonly string[] = [
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
];

export function usHighImpactTimes(from: number, to: number): number[] {
  const out: number[] = [];
  const start = zonedParts(from, NY);
  let y = start.year, m = start.month;
  for (let guard = 0; guard < 40; guard++) {
    // First Friday of the month at 08:30 New York.
    for (let d = 1; d <= 7; d++) {
      const t = wallToUtc(y, m, d, 8, 30, NY);
      if (zonedParts(t, NY).weekday === 'Fri') { if (t >= from && t <= to) out.push(t); break; }
    }
    if (wallToUtc(y, m, 1, 0, 0, NY) > to) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  for (const day of FOMC) {
    const [yy, mm, dd] = day.split('-').map(Number) as [number, number, number];
    const t = wallToUtc(yy, mm, dd, 14, 0, NY);
    if (t >= from && t <= to) out.push(t);
  }
  return out.sort((a, b) => a - b);
}
