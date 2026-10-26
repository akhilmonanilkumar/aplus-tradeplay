import "server-only";

/** Server-side fetch with a timeout and a readable error. */
export async function getJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 8000, ...rest } = init;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", ...rest, signal: ctl.signal, headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (A+ Tradeplay desk)", ...(rest.headers ?? {}) } });
    if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`${new URL(url).host} timed out`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function getText(url: string, timeoutMs = 8000): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (A+ Tradeplay desk)", accept: "application/rss+xml, application/xml, text/xml, */*" } });
    if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** Per-instance memo with expiry, so one warm function serves many viewers without re-hitting vendors. */
const memo = new Map<string, { at: number; ttl: number; v: Promise<unknown> }>();
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.v as Promise<T>;
  if (memo.size > 500) for (const [k, x] of memo) if (now - x.at > x.ttl) memo.delete(k);
  const v = fn().catch((e) => { memo.delete(key); throw e; });
  memo.set(key, { at: now, ttl: ttlMs, v });
  return v;
}

/** JSON response cached at the CDN edge for `sMaxAge` seconds. */
export function json(data: unknown, sMaxAge = 0, status = 200) {
  return Response.json(data, {
    status,
    headers: sMaxAge > 0 ? { "cache-control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge * 3}` } : { "cache-control": "no-store" },
  });
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
