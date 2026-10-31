import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { verifyEngine, verifyRelay } from "./auth.js";
import { errMsg } from "./http.js";
import type { MarketHub } from "./market.js";
import type { TickStore } from "./store.js";
import type { CoinSwitchVenue } from "./venues/coinswitch.js";
import type { DeltaVenue } from "./venues/delta.js";
import type { FyersVenue } from "./venues/fyers.js";
import type { CTraderSync } from "./venues/ctrader.js";

/** Trading endpoints each venue may reach. Anything else is refused. Writes also need the venue's execution switch. */
export const ALLOW = {
  delta: [/^\/v2\/orders(\/history|\/batch)?$/, /^\/v2\/positions(\/margined)?$/, /^\/v2\/wallet\/balances$/, /^\/v2\/products\/\d+\/orders\/leverage$/, /^\/v2\/fills$/],
  coinswitch: [/^\/v5\/order\/(create|cancel|cancel-all|realtime|history)$/, /^\/v5\/position\/(list|set-leverage|switch-mode)$/, /^\/v5\/execution\/list$/],
  fyers: [/^\/api\/v3\/(profile|funds|positions|orders|tradebook|holdings)$/, /^\/api\/v3\/orders\/sync$/],
};
export const allowed = (venue: keyof typeof ALLOW, method: string, path: string, execution: boolean) =>
  ALLOW[venue].some((r) => r.test(path)) && (method === "GET" || execution);

interface Deps { hub: MarketHub; store: TickStore; delta: DeltaVenue; coinswitch: CoinSwitchVenue; fyers: FyersVenue; ctrader: CTraderSync; startedAt: number }

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 256_000) throw new Error("body too large"); }
  return raw;
}

export function startServer(d: Deps) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://engine");
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - d.startedAt) / 1000) });
      const raw = method === "GET" ? "" : await readBody(req);

      // Old relay clients (the web app's DELTA_RELAY_URL) keep working against this host.
      if (method === "POST" && url.pathname === "/delta" && req.headers["x-relay-sig"]) {
        if (!verifyRelay(config.secret, { ts: String(req.headers["x-relay-ts"] ?? ""), sig: String(req.headers["x-relay-sig"] ?? "") }, raw)) return send(res, 401, { success: false, error: "unauthorised" });
        return proxyDelta(d, raw, res);
      }
      if (!verifyEngine(config.secret, { ts: String(req.headers["x-engine-ts"] ?? ""), sig: String(req.headers["x-engine-sig"] ?? "") }, method, url.pathname + url.search, raw)) {
        return send(res, 401, { error: "unauthorised" });
      }

      if (method === "GET" && url.pathname === "/status") {
        return send(res, 200, {
          at: Date.now(), uptimeSec: Math.round((Date.now() - d.startedAt) / 1000), publicIp: config.publicIp || null,
          venues: [d.delta.status(), d.coinswitch.status(), d.fyers.status()], store: d.store.status(), markets: d.hub.keys(),
        });
      }
      if (method === "GET" && url.pathname === "/flow") {
        const venue = url.searchParams.get("venue") ?? "delta", symbol = url.searchParams.get("symbol") ?? "BTCUSD";
        const snap = d.hub.snapshot(venue, symbol, {
          bucketMs: Number(url.searchParams.get("bucket") ?? 300_000), tick: Number(url.searchParams.get("tick") ?? 10),
          bars: Math.min(48, Number(url.searchParams.get("bars") ?? 12)), depthPct: Number(url.searchParams.get("depth") ?? 0.01),
        });
        return snap ? send(res, 200, snap) : send(res, 404, { error: `no data for ${venue}:${symbol} yet` });
      }
      if (method === "POST" && url.pathname === "/delta") return proxyDelta(d, raw, res);
      if (method === "POST" && url.pathname === "/coinswitch") {
        const r = JSON.parse(raw) as { method: string; path: string; params?: Record<string, string | number>; body?: unknown };
        if (!allowed("coinswitch", r.method, r.path, config.coinswitch.execution)) return send(res, 403, { error: "endpoint not allowed or execution is off" });
        if (r.method !== "GET" && !d.coinswitch.clock.healthy(d.coinswitch.budgetMs)) return send(res, 503, { error: "CoinSwitch clock out of budget" });
        const out = await d.coinswitch.request(r.method, r.path, r.params ?? {}, r.body ?? null);
        return send(res, 200, out.env);
      }
      if (method === "GET" && url.pathname === "/ctrader") return send(res, 200, d.ctrader.snapshot());
      if (method === "GET" && url.pathname === "/ctrader/auth-url") return send(res, 200, { url: d.ctrader.authUrl() });
      if (method === "POST" && url.pathname === "/ctrader/code") {
        const { code } = JSON.parse(raw) as { code?: string };
        if (!code) return send(res, 400, { error: "code missing" });
        await d.ctrader.exchangeCode(code);
        return send(res, 200, { ok: true });
      }
      if (method === "GET" && url.pathname === "/fyers/login-url") return send(res, 200, { url: d.fyers.loginUrl() });
      if (method === "POST" && url.pathname === "/fyers/token") {
        const { code } = JSON.parse(raw) as { code?: string };
        if (!code) return send(res, 400, { error: "auth code missing" });
        await d.fyers.exchangeAuthCode(code);
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/fyers") {
        const r = JSON.parse(raw) as { method: string; path: string; body?: { symbol?: string; qty?: number } | null };
        if (!allowed("fyers", r.method, r.path, config.fyers.execution)) return send(res, 403, { error: "endpoint not allowed or execution is off" });
        if (r.path === "/api/v3/orders/sync" && r.method === "POST") await d.fyers.validateSymbol(String(r.body?.symbol ?? ""), Number(r.body?.qty ?? 0));
        const out = await d.fyers.request(r.method, r.path, r.body ?? null);
        return send(res, out.status, out.body);
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 502, { error: errMsg(e) });
    }
  });
  server.listen(config.port, () => console.log(`engine host listening on :${config.port}`));
  return server;
}

async function proxyDelta(d: Deps, raw: string, res: ServerResponse) {
  const r = JSON.parse(raw) as { env?: string; method: string; path: string; query?: Record<string, string | number>; body?: unknown };
  if (r.env && r.env !== config.delta.env) return send(res, 400, { success: false, error: `engine host trades on Delta ${config.delta.env}, not ${r.env}` });
  if (!["GET", "POST", "PUT", "DELETE"].includes(r.method) || !allowed("delta", r.method, r.path, config.delta.execution)) return send(res, 403, { success: false, error: "endpoint not allowed or execution is off" });
  const out = await d.delta.signed(r.method, r.path, r.query ?? {}, r.body ?? null);
  return send(res, out.status, out.body);
}
