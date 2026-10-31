/** fetch with a timeout and the timings clock sync needs. */
export interface Timed<T> { status: number; ok: boolean; body: T; sentAt: number; receivedAt: number; date: number | null }

export async function timedFetch<T = unknown>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Timed<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const sentAt = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, headers: { "user-agent": "aplus-engine-host", ...(init.headers ?? {}) } });
    const text = await res.text();
    const receivedAt = Date.now();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    const d = res.headers.get("date");
    return { status: res.status, ok: res.ok, body: body as T, sentAt, receivedAt, date: d ? Date.parse(d) : null };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`${url.split("?")[0]} timed out after ${timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
