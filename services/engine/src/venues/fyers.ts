import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CLOCK_BUDGET_MS, config } from "../config.js";
import { timedFetch } from "../http.js";
import type { MarketHub } from "../market.js";
import { HOST_TF_MS, type HostCandle, type HostQuote, type HostTf } from "../candles.js";
import { VenueBase } from "./types.js";

/**
 * Fyers API v3. Orders must come from this host: Fyers accepts API orders only from a registered app
 * mapped to a whitelisted static IP (SEBI retail-algo rules from 1 April 2026). Market data needs no
 * static IP but uses the same daily token.
 */
export const FYERS_API = "https://api-t1.fyers.in";
const FYERS_RES: Record<HostTf, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
const MASTER_URL = "https://public.fyers.in/sym_details/NSE_FO_sym_master.json";

interface Token { access_token: string; refresh_token?: string; saved_at: number; login_at?: number }

/** Fyers refresh tokens last 15 days from the full login. */
export const REFRESH_DAYS = 15;

export const appIdHash = (appId: string, secretId: string) => createHash("sha256").update(`${appId}:${secretId}`).digest("hex");

/** NSE cash and F&O session, IST 09:15–15:30 on weekdays (holidays come from /data/marketStatus). */
export function nseOpen(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  const d = ist.getUTCDay(), m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return d >= 1 && d <= 5 && m >= 9 * 60 + 15 && m < 15 * 60 + 30;
}

/** A Fyers access token is valid for the trading day it was issued (it lapses overnight). */
export function tokenFresh(t: Token | null, now = Date.now()): boolean {
  if (!t?.access_token) return false;
  const day = (ms: number) => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return day(t.saved_at) === day(now);
}

export class FyersVenue extends VenueBase {
  readonly id = "fyers";
  readonly name = "Fyers";
  readonly budgetMs = CLOCK_BUDGET_MS.fyers;
  private token: Token | null = null;
  private master: Map<string, { lot: number; tick: number }> | null = null;
  private masterAt = 0;

  constructor(private readonly hub: MarketHub) { super(); }

  private get app() { return config.fyers.appId && config.fyers.secretId ? { id: config.fyers.appId, hash: appIdHash(config.fyers.appId, config.fyers.secretId) } : null; }

  async start() {
    this.token = await readFile(config.fyers.tokenFile, "utf8").then((s) => JSON.parse(s) as Token).catch(() => null);
    this.every(60_000, () => this.syncClock());
    this.every(5 * 60_000, () => this.keepToken());
    this.every(5_000, () => this.poll());
  }

  private headers() { return { authorization: `${config.fyers.appId}:${this.token?.access_token ?? ""}`, "content-type": "application/json" }; }

  /** Sign-in link for the daily login; the redirect carries the auth code to POST /fyers/token. */
  loginUrl(state = "aplus") {
    if (!this.app) throw new Error("FYERS_APP_ID and FYERS_SECRET_ID are not set");
    const q = new URLSearchParams({ client_id: config.fyers.appId, redirect_uri: config.fyers.redirectUri, response_type: "code", state });
    return `${FYERS_API}/api/v3/generate-authcode?${q}`;
  }

  async exchangeAuthCode(code: string) {
    const app = this.app;
    if (!app) throw new Error("Fyers app is not configured");
    const r = await timedFetch<{ s: string; access_token?: string; refresh_token?: string; message?: string }>(`${FYERS_API}/api/v3/validate-authcode`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", appIdHash: app.hash, code }),
    });
    if (r.body?.s !== "ok" || !r.body.access_token) throw new Error(`Fyers login failed: ${r.body?.message ?? r.status}`);
    await this.save({ access_token: r.body.access_token, refresh_token: r.body.refresh_token, saved_at: Date.now(), login_at: Date.now() });
  }

  /** New day: renew the access token from the 15-day refresh token and PIN, when both are present. */
  private async keepToken() {
    if (tokenFresh(this.token) || !this.token?.refresh_token || !config.fyers.pin || !this.app) return;
    const r = await timedFetch<{ s: string; access_token?: string; message?: string }>(`${FYERS_API}/api/v3/validate-refresh-token`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", appIdHash: this.app.hash, refresh_token: this.token.refresh_token, pin: config.fyers.pin }),
    });
    if (r.body?.s === "ok" && r.body.access_token) await this.save({ ...this.token, access_token: r.body.access_token, saved_at: Date.now() });
    else this.stream.error = `Token refresh failed: ${r.body?.message ?? r.status}. Log in again.`;
  }

  private async save(t: Token) {
    this.token = t;
    await mkdir(dirname(config.fyers.tokenFile), { recursive: true });
    await writeFile(config.fyers.tokenFile, JSON.stringify(t), { mode: 0o600 });
  }

  /** Fyers has no time endpoint: the HTTP Date header (1 s precision) is the reference. */
  async syncClock() {
    const r = await timedFetch(`${FYERS_API}/data/marketStatus`, { headers: this.headers() }, 8_000);
    if (r.date) this.clock.add(r.sentAt, r.receivedAt, r.date + 500);
  }

  private async poll() {
    if (!tokenFresh(this.token)) { this.stream.state = "off"; return; }
    if (!nseOpen()) { this.stream.state = "closed"; return; }
    this.stream.state = "polling";
    const q = await timedFetch<{ s: string; d?: { n: string; v: Record<string, number> }[] }>(`${FYERS_API}/data/quotes?symbols=${encodeURIComponent(config.fyers.symbols.join(","))}`, { headers: this.headers() });
    for (const row of q.body?.d ?? []) {
      this.hub.setTicker("fyers", row.n, { t: Date.now(), last: row.v.lp, change24hPct: row.v.chp, volume: row.v.volume, oi: row.v.oi });
    }
    const focus = config.fyers.symbols[0];
    if (focus) {
      const d = await timedFetch<{ s: string; d?: Record<string, { bids: { price: number; volume: number }[]; ask: { price: number; volume: number }[] }> }>(`${FYERS_API}/data/depth?symbol=${encodeURIComponent(focus)}&ot_flag=1`, { headers: this.headers() });
      const book = d.body?.d?.[focus];
      if (book) this.hub.setBook("fyers", focus, { bids: book.bids.map((l) => ({ price: l.price, size: l.volume })), asks: book.ask.map((l) => ({ price: l.price, size: l.volume })), t: Date.now() });
    }
    this.seen();
  }

  /** Fyers' own candles (/data/history), oldest first. Intraday requests stay within Fyers' 100-day window. */
  async candles(symbol: string, tf: HostTf, limit: number, endTime = Date.now()): Promise<HostCandle[]> {
    if (!tokenFresh(this.token)) throw new Error("Fyers session expired; log in for today on Integrations");
    const ms = HOST_TF_MS[tf];
    // Calendar span for `limit` bars of a 6¼-hour session day, capped at Fyers' window.
    const perDay = tf === "1d" ? 1 : Math.max(1, Math.floor(375 * 60_000 / ms));
    const days = Math.min(tf === "1d" ? 365 : 99, Math.ceil((limit / perDay) * 1.6) + 4);
    const to = Math.floor(endTime / 1000), from = to - days * 86_400;
    const q = new URLSearchParams({ symbol, resolution: FYERS_RES[tf], date_format: "0", range_from: String(from), range_to: String(to), cont_flag: "1" });
    const r = await timedFetch<{ s: string; candles?: number[][]; message?: string }>(`${FYERS_API}/data/history?${q}`, { headers: this.headers() }, 15_000);
    if (r.body?.s !== "ok") throw new Error(`Fyers history: ${r.body?.message ?? `HTTP ${r.status}`}`);
    return (r.body.candles ?? []).map((x) => ({ t: x[0]! * 1000, o: x[1]!, h: x[2]!, l: x[3]!, c: x[4]!, v: x[5] ?? 0 })).slice(-limit);
  }

  /** Latest Fyers price: the polled ticker while it is fresh, else a direct quote. */
  async quote(symbol: string): Promise<HostQuote> {
    const tk = this.hub.ticker("fyers", symbol), book = this.hub.book("fyers", symbol);
    if (tk?.last && Date.now() - tk.t < 15_000) return { last: tk.last, bid: book?.bids[0]?.price ?? null, ask: book?.asks[0]?.price ?? null, ts: tk.t, source: "Fyers" };
    if (!tokenFresh(this.token)) throw new Error("Fyers session expired; log in for today on Integrations");
    const q = await timedFetch<{ s: string; d?: { n: string; v: Record<string, number> }[]; message?: string }>(`${FYERS_API}/data/quotes?symbols=${encodeURIComponent(symbol)}`, { headers: this.headers() });
    const v = q.body?.d?.[0]?.v;
    if (!v?.lp) throw new Error(`Fyers quote: ${q.body?.message ?? "no price"}`);
    return { last: v.lp, bid: v.bid || null, ask: v.ask || null, ts: Date.now(), source: "Fyers" };
  }

  /** Daily F&O symbol master: every order symbol must exist and its quantity must be a lot multiple. */
  async validateSymbol(symbol: string, qty: number) {
    if (!this.master || Date.now() - this.masterAt > 12 * 3_600_000) {
      const r = await timedFetch<Record<string, { minLotSize?: number; tickSize?: number }>>(MASTER_URL, {}, 30_000);
      if (!r.ok || typeof r.body !== "object" || !r.body) throw new Error("Could not load the Fyers symbol master");
      this.master = new Map(Object.entries(r.body).map(([k, v]) => [k, { lot: Number(v.minLotSize ?? 1), tick: Number(v.tickSize ?? 0.05) }]));
      this.masterAt = Date.now();
    }
    const m = this.master.get(symbol);
    if (!m) throw new Error(`${symbol} is not in today's Fyers symbol master`);
    if (qty <= 0 || qty % m.lot !== 0) throw new Error(`${symbol} trades in lots of ${m.lot}; ${qty} is not a multiple`);
    return m;
  }

  async request(method: string, path: string, body: unknown = null) {
    if (!tokenFresh(this.token)) throw new Error("Fyers session expired; log in again");
    return timedFetch(`${FYERS_API}${path}`, { method, headers: this.headers(), body: body === null ? undefined : JSON.stringify(body) });
  }

  status() {
    const fresh = tokenFresh(this.token);
    const loginAt = this.token?.login_at ?? null;
    return this.baseStatus({
      login: { fresh, at: this.token?.saved_at ?? null, renewsUntil: loginAt && this.token?.refresh_token ? loginAt + REFRESH_DAYS * 86_400_000 : null, autoRenew: !!config.fyers.pin },
      env: "production", keys: !!this.app && fresh, execution: config.fyers.execution, symbols: config.fyers.symbols,
      note: !this.app ? "Set FYERS_APP_ID and FYERS_SECRET_ID." : fresh ? undefined : "Log in for today (Integrations → Fyers).",
    });
  }
}
