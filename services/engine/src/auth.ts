import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Requests from the web app carry x-engine-ts (ms) and x-engine-sig =
 * HMAC-SHA256(secret, ts + METHOD + path-with-query + body), hex. Valid for 30 s either side.
 */
export function engineSignature(secret: string, ts: string, method: string, pathWithQuery: string, body: string) {
  return createHmac("sha256", secret).update(ts + method.toUpperCase() + pathWithQuery + body).digest("hex");
}

export function verifyEngine(secret: string, h: { ts?: string; sig?: string }, method: string, pathWithQuery: string, body: string, now = Date.now()): boolean {
  if (!secret || !h.ts || !h.sig) return false;
  if (!(Math.abs(now - Number(h.ts)) < 30_000)) return false;
  return safeEq(h.sig, engineSignature(secret, h.ts, method, pathWithQuery, body));
}

/** The older Delta relay scheme (x-relay-ts / x-relay-sig over ts + body), kept so DELTA_RELAY_URL can point here. */
export function verifyRelay(secret: string, h: { ts?: string; sig?: string }, body: string, now = Date.now()): boolean {
  if (!secret || !h.ts || !h.sig) return false;
  if (!(Math.abs(now - Number(h.ts)) < 30_000)) return false;
  return safeEq(h.sig, createHmac("sha256", secret).update(h.ts + body).digest("hex"));
}

function safeEq(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
