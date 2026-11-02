// Delta Exchange relay: runs on a server with a fixed IP (whitelisted on the Delta API key), holds the
// keys, and forwards only HMAC-authenticated requests from the platform. No dependencies (Node ≥ 20).
//
//   DELTA_TESTNET_API_KEY / DELTA_TESTNET_API_SECRET   testnet keys
//   DELTA_API_KEY / DELTA_API_SECRET                    production keys (optional)
//   DELTA_RELAY_SECRET                                  shared with the platform (same env var there)
//   PORT                                                default 8787 — put it behind HTTPS (Caddy / nginx)
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const HOSTS = { production: "https://api.india.delta.exchange", testnet: "https://cdn-ind.testnet.deltaex.org" };
const KEYS = {
  production: [process.env.DELTA_API_KEY, process.env.DELTA_API_SECRET],
  testnet: [process.env.DELTA_TESTNET_API_KEY, process.env.DELTA_TESTNET_API_SECRET],
};
const SECRET = process.env.DELTA_RELAY_SECRET ?? "";
// Only the endpoints the platform uses.
const ALLOWED = [/^\/v2\/orders(\/history)?$/, /^\/v2\/positions(\/margined)?$/, /^\/v2\/wallet\/balances$/, /^\/v2\/products\/\d+\/orders\/leverage$/, /^\/v2\/fills$/];

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/delta") return send(res, 404, { success: false, error: "not found" });
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) return send(res, 413, { success: false, error: "too large" }); }
  const ts = String(req.headers["x-relay-ts"] ?? ""), sig = String(req.headers["x-relay-sig"] ?? "");
  const want = createHmac("sha256", SECRET).update(ts + raw).digest("hex");
  const fresh = Math.abs(Date.now() - Number(ts)) < 30_000;
  if (!SECRET || !fresh || sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return send(res, 401, { success: false, error: "unauthorised" });
  let r;
  try { r = JSON.parse(raw); } catch { return send(res, 400, { success: false, error: "bad json" }); }
  const env = r.env === "production" ? "production" : "testnet";
  const [key, secret] = KEYS[env];
  if (!key || !secret) return send(res, 400, { success: false, error: `${env} keys not set on the relay` });
  if (!["GET", "POST", "PUT", "DELETE"].includes(r.method) || !ALLOWED.some((x) => x.test(r.path))) return send(res, 403, { success: false, error: "endpoint not allowed" });
  const q = r.query && Object.keys(r.query).length ? `?${new URLSearchParams(Object.entries(r.query).map(([k, v]) => [k, String(v)]))}` : "";
  const body = r.body === null || r.body === undefined ? "" : JSON.stringify(r.body);
  const t = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(r.method + t + r.path + q + body).digest("hex");
  try {
    const up = await fetch(`${HOSTS[env]}${r.path}${q}`, { method: r.method, body: body || undefined, headers: { "api-key": key, timestamp: t, signature, "content-type": "application/json", "user-agent": "aplus-tradeplay-relay" } });
    const text = await up.text();
    res.writeHead(up.status, { "content-type": "application/json" });
    res.end(text);
  } catch (e) {
    send(res, 502, { success: false, error: `upstream: ${e.message}` });
  }
}).listen(Number(process.env.PORT ?? 8787), () => console.log("delta relay listening"));
