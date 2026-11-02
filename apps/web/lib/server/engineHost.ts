import "server-only";
import { createHmac } from "node:crypto";

/**
 * Client for the engine host (services/engine) on the fixed-IP server. Requests are signed with
 * ENGINE_SECRET: HMAC-SHA256(ts + METHOD + path?query + body), sent as x-engine-ts / x-engine-sig.
 */
export const engineConfigured = () => !!(process.env.ENGINE_URL?.trim() && process.env.ENGINE_SECRET?.trim());

export function engineSignature(secret: string, ts: string, method: string, pathWithQuery: string, body: string) {
  return createHmac("sha256", secret).update(ts + method.toUpperCase() + pathWithQuery + body).digest("hex");
}

export async function engineFetch<T>(method: "GET" | "POST", pathWithQuery: string, body?: unknown, timeoutMs = 8000): Promise<T> {
  const base = process.env.ENGINE_URL?.trim().replace(/\/$/, ""), secret = process.env.ENGINE_SECRET?.trim();
  if (!base || !secret) throw new Error("Engine host is not connected (ENGINE_URL / ENGINE_SECRET)");
  const raw = body === undefined ? "" : JSON.stringify(body);
  const ts = String(Date.now());
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${pathWithQuery}`, {
      method, cache: "no-store", signal: ctl.signal, body: raw || undefined,
      headers: { "content-type": "application/json", "x-engine-ts": ts, "x-engine-sig": engineSignature(secret, ts, method, pathWithQuery, raw) },
    });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(`engine host: ${j.error ?? `HTTP ${res.status}`}`);
    return j;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error("engine host timed out");
    throw e;
  } finally {
    clearTimeout(t);
  }
}
