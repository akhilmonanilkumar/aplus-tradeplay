/** Candles the host serves to the web app, one shape for every venue. */
export interface HostCandle { t: number; o: number; h: number; l: number; c: number; v: number }
export type HostTf = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export const HOST_TF_MS: Record<HostTf, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
export const isHostTf = (x: string | null): x is HostTf => !!x && x in HOST_TF_MS;
export interface HostQuote { last: number; bid: number | null; ask: number | null; ts: number; source: string }

/** Short-lived memo so a busy dashboard cannot burn a venue's rate limit. */
const memo = new Map<string, { until: number; v: Promise<unknown> }>();
export function remember<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.until > now) return hit.v as Promise<T>;
  const v = fn();
  memo.set(key, { until: now + ttlMs, v });
  v.catch(() => memo.delete(key));
  if (memo.size > 500) for (const [k, x] of memo) if (x.until <= now) memo.delete(k);
  return v;
}
