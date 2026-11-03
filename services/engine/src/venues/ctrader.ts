import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { timedFetch } from "../http.js";
import { HOST_TF_MS, type HostCandle, type HostQuote, type HostTf } from "../candles.js";

/**
 * cTrader Open API, read-only: balances and open positions of the prop accounts, so the CFD Arena tracks
 * what was actually placed from the alert links, and the CFD Arena's prices (trendbars and live spots)
 * straight from the prop broker's own feed. Uses the JSON protocol on port 5036 and the "accounts"
 * scope; this code sends no trading messages.
 */
export const CT_HOSTS = { live: "wss://live.ctraderapi.com:5036", demo: "wss://demo.ctraderapi.com:5036" } as const;
export const PT = {
  HEARTBEAT: 51,
  APP_AUTH_REQ: 2100, APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102, ACCOUNT_AUTH_RES: 2103,
  SYMBOLS_LIST_REQ: 2114, SYMBOLS_LIST_RES: 2115,
  SUBSCRIBE_SPOTS_REQ: 2127, SUBSCRIBE_SPOTS_RES: 2128, SPOT_EVENT: 2131,
  GET_TRENDBARS_REQ: 2137, GET_TRENDBARS_RES: 2138,
  TRADER_REQ: 2121, TRADER_RES: 2122,
  RECONCILE_REQ: 2124, RECONCILE_RES: 2125,
  DEAL_LIST_REQ: 2133, DEAL_LIST_RES: 2134,
  EXECUTION_EVENT: 2126,
  ERROR_RES: 2142,
  ACCOUNTS_BY_TOKEN_REQ: 2149, ACCOUNTS_BY_TOKEN_RES: 2150,
} as const;

export interface CtPosition { id: number; symbol: string; side: "long" | "short"; units: number; entry: number; sl: number | null; tp: number | null; swap: number; commission: number; openedAt: number; comment: string | null }
/** A position closed on the broker: one row per closing deal (partial closes give several). */
export interface CtClosed {
  dealId: number; positionId: number; symbol: string; side: "long" | "short"; units: number;
  entry: number; exit: number; sl: number | null; pnl: number; fees: number; openedAt: number | null; closedAt: number; balanceAfter: number | null; comment: string | null;
}

export interface CtAccount { ctid: number; login: number | null; isLive: boolean; balance: number | null; positions: CtPosition[]; syncedAt: number | null; error: string | null }

interface Token { access_token: string; refresh_token?: string; saved_at: number }
type Msg = { payloadType: number; clientMsgId?: string; payload?: Record<string, unknown> };

/** ProtoOATrendbarPeriod values. */
const PERIOD: Record<HostTf, number> = { "1m": 1, "5m": 5, "15m": 7, "1h": 9, "4h": 10, "1d": 12 };
/** cTrader sends prices as integers in 1/100,000 of a unit. */
const PX = 100_000;

/**
 * Closing deals → closed trades. A closing deal's side is the opposite of the position's; money fields are
 * in 10^-moneyDigits; volume in hundredths of a unit. Opening times and stops come from what the host saw.
 */
export function parseDeals(payload: Record<string, unknown>, symbols: Map<number, string>, seen: Map<number, { sl: number | null; openedAt: number; comment: string | null }> = new Map()): CtClosed[] {
  const list = (payload.deal as Record<string, unknown>[] | undefined) ?? [];
  const opened = new Map<number, number>();
  for (const d of list) if (!d.closePositionDetail) {
    const pid = Number(d.positionId), t = Number(d.executionTimestamp ?? d.createTimestamp ?? 0);
    if (t && (!opened.has(pid) || t < opened.get(pid)!)) opened.set(pid, t);
  }
  return list.filter((d) => d.closePositionDetail && Number(d.dealStatus ?? 2) === 2).map((d) => {
    const c = d.closePositionDetail as Record<string, unknown>;
    const md = Number(c.moneyDigits ?? d.moneyDigits ?? 2);
    const money = (x: unknown) => Number(x ?? 0) / 10 ** md;
    const pid = Number(d.positionId);
    const sold = Number(d.tradeSide) === 2 || d.tradeSide === "SELL";
    const commission = money(c.commission), swap = money(c.swap);
    const s = seen.get(pid);
    return {
      dealId: Number(d.dealId), positionId: pid, symbol: symbols.get(Number(d.symbolId)) ?? String(d.symbolId),
      side: sold ? "long" : "short", units: Number(c.closedVolume ?? d.filledVolume ?? d.volume ?? 0) / 100,
      entry: Number(c.entryPrice ?? 0), exit: Number(d.executionPrice ?? 0), sl: s?.sl ?? null,
      pnl: Math.round((money(c.grossProfit) + swap + commission) * 100) / 100, fees: Math.round(-(commission + swap) * 100) / 100,
      openedAt: s?.openedAt ?? opened.get(pid) ?? null, closedAt: Number(d.executionTimestamp ?? d.createTimestamp ?? 0),
      balanceAfter: c.balance === undefined ? null : money(c.balance), comment: s?.comment ?? null,
    } satisfies CtClosed;
  });
}

/** Trendbars → candles: low plus deltas, timestamps in minutes. */
export function parseTrendbars(payload: Record<string, unknown>): HostCandle[] {
  const list = (payload.trendbar as Record<string, unknown>[] | undefined) ?? [];
  return list.map((b) => {
    const low = Number(b.low ?? 0);
    const px = (x: number) => Number((x / PX).toFixed(5));
    return {
      t: Number(b.utcTimestampInMinutes ?? 0) * 60_000,
      o: px(low + Number(b.deltaOpen ?? 0)), h: px(low + Number(b.deltaHigh ?? 0)), l: px(low), c: px(low + Number(b.deltaClose ?? 0)),
      v: Number(b.volume ?? 0),
    };
  }).filter((c) => c.t > 0 && c.l > 0).sort((a, b) => a.t - b.t);
}

/** Broker symbol for an app symbol: an explicit map first (CTRADER_SYMBOL_MAP), then an exact or suffixed match. */
export function matchSymbol(want: string, names: Map<number, string>, overrides: Record<string, string> = {}): number | null {
  const target = (overrides[want] ?? want).toUpperCase();
  const norm = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, "");
  let best: number | null = null;
  for (const [id, name] of names) {
    if (name.toUpperCase() === target) return id;
    if (best === null && norm(name).startsWith(norm(target)) && norm(name).length <= norm(target).length + 3) best = id;
  }
  return best;
}

/** Positions from a reconcile response: volume arrives in hundredths of a unit, money in 10^-moneyDigits. */
export function parsePositions(payload: Record<string, unknown>, symbols: Map<number, string>): CtPosition[] {
  const list = (payload.position as Record<string, unknown>[] | undefined) ?? [];
  return list.map((p) => {
    const td = (p.tradeData ?? {}) as Record<string, unknown>;
    const md = Number(p.moneyDigits ?? 2);
    const money = (x: unknown) => Number(x ?? 0) / 10 ** md;
    return {
      id: Number(p.positionId), symbol: symbols.get(Number(td.symbolId)) ?? String(td.symbolId), side: Number(td.tradeSide) === 2 || td.tradeSide === "SELL" ? "short" : "long",
      units: Number(td.volume ?? 0) / 100, entry: Number(p.price ?? 0), sl: p.stopLoss === undefined ? null : Number(p.stopLoss), tp: p.takeProfit === undefined ? null : Number(p.takeProfit),
      swap: money(p.swap), commission: money(p.commission), openedAt: Number(td.openTimestamp ?? 0), comment: (td.comment as string | undefined) ?? (td.label as string | undefined) ?? null,
    };
  });
}

export class CTraderSync {
  private token: Token | null = null;
  private accounts = new Map<number, CtAccount>();
  private symbols = new Map<number, Map<number, string>>();
  private sockets: Partial<Record<keyof typeof CT_HOSTS, WebSocket>> = {};
  private timers: ReturnType<typeof setInterval>[] = [];
  private seq = 0;
  private pending = new Map<string, { resolve: (m: Msg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private spots = new Map<string, { bid: number | null; ask: number | null; ts: number }>();
  private subscribed = new Set<string>();
  /** Stop, open time and comment of every position seen open, so closed trades keep them. */
  private seen = new Map<number, { sl: number | null; openedAt: number; comment: string | null }>();
  error: string | null = null;

  constructor(private readonly cfg: { clientId: string; clientSecret: string; redirectUri: string; tokenFile: string; symbolMap?: Record<string, string> }) {}

  get configured() { return !!(this.cfg.clientId && this.cfg.clientSecret); }

  async start() {
    if (!this.configured) return;
    this.token = await readFile(this.cfg.tokenFile, "utf8").then((s) => JSON.parse(s) as Token).catch(() => null);
    this.timers.push(setInterval(() => void this.refreshToken().catch((e) => (this.error = (e as Error).message)), 6 * 3_600_000));
    this.timers.push(setInterval(() => this.poll(), 30_000));
    this.timers.push(setInterval(() => { for (const ws of Object.values(this.sockets)) this.send(ws, PT.HEARTBEAT, {}); }, 10_000));
    if (this.token) this.connect("demo");
  }

  stop() { for (const t of this.timers) clearInterval(t); for (const ws of Object.values(this.sockets)) ws?.close(); }

  /** Link the trader signs in to; the "accounts" scope is read-only. */
  authUrl() {
    const q = new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, scope: "accounts", product: "web" });
    return `https://id.ctrader.com/my/settings/openapi/grantingaccess/?${q}`;
  }

  async exchangeCode(code: string) {
    const q = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret });
    await this.saveFrom(await timedFetch<Record<string, unknown>>(`https://openapi.ctrader.com/apps/token?${q}`));
  }

  /** Refresh well before expiry (cTrader access tokens last about 30 days). */
  private async refreshToken() {
    if (!this.token?.refresh_token || Date.now() - this.token.saved_at < 20 * 86_400_000) return;
    const q = new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.token.refresh_token, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret });
    await this.saveFrom(await timedFetch<Record<string, unknown>>(`https://openapi.ctrader.com/apps/token?${q}`));
  }

  private async saveFrom(r: { body: Record<string, unknown> }) {
    const access = (r.body?.accessToken ?? r.body?.access_token) as string | undefined;
    if (!access) throw new Error(`cTrader token: ${String(r.body?.description ?? r.body?.errorCode ?? "no access token")}`);
    this.token = { access_token: access, refresh_token: (r.body.refreshToken ?? r.body.refresh_token) as string | undefined, saved_at: Date.now() };
    await mkdir(dirname(this.cfg.tokenFile), { recursive: true });
    await writeFile(this.cfg.tokenFile, JSON.stringify(this.token), { mode: 0o600 });
    for (const ws of Object.values(this.sockets)) ws?.close();
    this.connect("demo");
  }

  private send(ws: WebSocket | undefined, payloadType: number, payload: Record<string, unknown>) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ clientMsgId: `m${++this.seq}`, payloadType, payload }));
  }

  /** Send and wait for the reply carrying the same clientMsgId. */
  private call(ws: WebSocket | undefined, payloadType: number, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<Msg> {
    if (ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("cTrader is not connected"));
    const id = `c${++this.seq}`;
    return new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("cTrader did not answer in time")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ clientMsgId: id, payloadType, payload }));
    });
  }

  /** The account whose broker feed prices the CFD Arena: the first authorised one with its symbol list loaded. */
  private feed(): { ctid: number; ws: WebSocket; names: Map<number, string> } | null {
    for (const a of this.accounts.values()) {
      const ws = this.sockets[a.isLive ? "live" : "demo"], names = this.symbols.get(a.ctid);
      if (ws?.readyState === WebSocket.OPEN && names?.size) return { ctid: a.ctid, ws, names };
    }
    return null;
  }

  private symbolId(symbol: string) {
    const f = this.feed();
    if (!f) throw new Error(this.token ? "cTrader is still connecting to the prop account" : "Sign in to cTrader on Integrations first");
    const id = matchSymbol(symbol, f.names, this.cfg.symbolMap);
    if (id === null) throw new Error(`${symbol} is not in the prop broker's symbol list; map it with CTRADER_SYMBOL_MAP`);
    return { ...f, id };
  }

  /** The prop broker's own candles, oldest first, paged to stay inside cTrader's per-request window. */
  async candles(symbol: string, tf: HostTf, limit: number, endTime = Date.now()): Promise<HostCandle[]> {
    const f = this.symbolId(symbol);
    const ms = HOST_TF_MS[tf];
    // Weekends close CFD markets, so ask for a wider span than `limit` bars; split into requests of ≤ 1,000 bars.
    const span = Math.ceil(limit * 1.5 + 2 * 86_400_000 / ms) * ms;
    const out: HostCandle[] = [];
    for (let to = endTime, from = endTime - span; to > from;) {
      const start = Math.max(from, to - 1000 * ms);
      const m = await this.call(f.ws, PT.GET_TRENDBARS_REQ, { ctidTraderAccountId: f.ctid, symbolId: f.id, period: PERIOD[tf], fromTimestamp: start, toTimestamp: to });
      out.unshift(...parseTrendbars(m.payload ?? {}));
      to = start;
    }
    const seen = new Set<number>();
    return out.filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true))).sort((a, b) => a.t - b.t).slice(-limit);
  }

  /** Closed trades of every signed-in account since `from` (deal history, in windows of a week). */
  async closed(from: number, to = Date.now()) {
    const out: { ctid: number; login: number | null; balance: number | null; trades: CtClosed[]; error: string | null }[] = [];
    for (const a of this.accounts.values()) {
      const ws = this.sockets[a.isLive ? "live" : "demo"];
      const trades: CtClosed[] = [];
      let error: string | null = null;
      try {
        for (let start = Math.max(from, to - 90 * 86_400_000); start < to; start += 7 * 86_400_000) {
          const m = await this.call(ws, PT.DEAL_LIST_REQ, { ctidTraderAccountId: a.ctid, fromTimestamp: start, toTimestamp: Math.min(to, start + 7 * 86_400_000), maxRows: 1000 }, 15_000);
          trades.push(...parseDeals(m.payload ?? {}, this.symbols.get(a.ctid) ?? new Map(), this.seen));
        }
      } catch (e) { error = (e as Error).message; }
      out.push({ ctid: a.ctid, login: a.login, balance: a.balance, trades, error });
    }
    return out;
  }

  /** Live bid / ask from the broker's spot stream (subscribed on first use). */
  async quote(symbol: string): Promise<HostQuote> {
    const f = this.symbolId(symbol);
    const key = `${f.ctid}:${f.id}`;
    if (!this.subscribed.has(key)) {
      this.subscribed.add(key);
      await this.call(f.ws, PT.SUBSCRIBE_SPOTS_REQ, { ctidTraderAccountId: f.ctid, symbolId: [f.id] }).catch((e) => { this.subscribed.delete(key); throw e; });
    }
    for (let i = 0; i < 30; i++) {
      const s = this.spots.get(key);
      if (s && (s.bid ?? s.ask) && Date.now() - s.ts < 120_000) {
        const last = s.bid !== null && s.ask !== null ? (s.bid + s.ask) / 2 : (s.bid ?? s.ask)!;
        return { last, bid: s.bid, ask: s.ask, ts: s.ts, source: "cTrader prop broker" };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`No cTrader price for ${symbol} yet (market closed?)`);
  }

  private connect(env: keyof typeof CT_HOSTS) {
    if (this.sockets[env] || !this.token) return;
    const ws = new WebSocket(CT_HOSTS[env]);
    this.sockets[env] = ws;
    ws.onopen = () => this.send(ws, PT.APP_AUTH_REQ, { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret });
    ws.onmessage = (ev) => { try { this.onMessage(env, ws, JSON.parse(String(ev.data)) as Msg); } catch (e) { this.error = (e as Error).message; } };
    ws.onclose = () => {
      delete this.sockets[env];
      // Spot subscriptions die with the socket; resubscribe on the next quote.
      this.subscribed.clear();
      setTimeout(() => this.connect(env), 15_000);
    };
    ws.onerror = () => { this.error = `cTrader ${env} socket error`; };
  }

  private onMessage(env: keyof typeof CT_HOSTS, ws: WebSocket, m: Msg) {
    const p = m.payload ?? {};
    const waiting = m.clientMsgId ? this.pending.get(m.clientMsgId) : undefined;
    if (waiting && m.payloadType !== PT.HEARTBEAT) {
      this.pending.delete(m.clientMsgId!);
      clearTimeout(waiting.timer);
      if (m.payloadType === PT.ERROR_RES || m.payloadType === 50) waiting.reject(new Error(`cTrader: ${String(p.errorCode ?? "error")} ${String(p.description ?? "")}`.trim()));
      else waiting.resolve(m);
      return;
    }
    if (m.payloadType === PT.SPOT_EVENT) {
      const key = `${Number(p.ctidTraderAccountId)}:${Number(p.symbolId)}`;
      const was = this.spots.get(key) ?? { bid: null, ask: null, ts: 0 };
      this.spots.set(key, { bid: p.bid !== undefined ? Number(p.bid) / PX : was.bid, ask: p.ask !== undefined ? Number(p.ask) / PX : was.ask, ts: Date.now() });
      return;
    }
    switch (m.payloadType) {
      case PT.APP_AUTH_RES:
        this.send(ws, PT.ACCOUNTS_BY_TOKEN_REQ, { accessToken: this.token?.access_token });
        break;
      case PT.ACCOUNTS_BY_TOKEN_RES: {
        for (const a of (p.ctidTraderAccount as Record<string, unknown>[] | undefined) ?? []) {
          const ctid = Number(a.ctidTraderAccountId), isLive = !!a.isLive;
          if (!this.accounts.has(ctid)) this.accounts.set(ctid, { ctid, login: a.traderLogin === undefined ? null : Number(a.traderLogin), isLive, balance: null, positions: [], syncedAt: null, error: null });
          // Each environment authorises its own accounts; open the other socket if any account lives there.
          if ((isLive ? "live" : "demo") === env) this.send(ws, PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: ctid, accessToken: this.token?.access_token });
          else this.connect(isLive ? "live" : "demo");
        }
        break;
      }
      case PT.ACCOUNT_AUTH_RES: {
        const ctid = Number(p.ctidTraderAccountId);
        this.send(ws, PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: ctid });
        this.request(ws, ctid);
        break;
      }
      case PT.SYMBOLS_LIST_RES: {
        const ctid = Number(p.ctidTraderAccountId);
        this.symbols.set(ctid, new Map(((p.symbol as Record<string, unknown>[] | undefined) ?? []).map((s) => [Number(s.symbolId), String(s.symbolName)])));
        break;
      }
      case PT.TRADER_RES: {
        const t = (p.trader ?? {}) as Record<string, unknown>;
        const acc = this.accounts.get(Number(p.ctidTraderAccountId ?? t.ctidTraderAccountId));
        if (acc) { acc.balance = Number(t.balance ?? 0) / 10 ** Number(t.moneyDigits ?? 2); acc.syncedAt = Date.now(); }
        break;
      }
      case PT.RECONCILE_RES: {
        const ctid = Number(p.ctidTraderAccountId);
        const acc = this.accounts.get(ctid);
        if (acc) {
          acc.positions = parsePositions(p, this.symbols.get(ctid) ?? new Map()); acc.syncedAt = Date.now(); acc.error = null;
          for (const x of acc.positions) this.seen.set(x.id, { sl: x.sl ?? this.seen.get(x.id)?.sl ?? null, openedAt: x.openedAt, comment: x.comment });
          if (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value!);
        }
        break;
      }
      case PT.EXECUTION_EVENT:
        this.request(ws, Number(p.ctidTraderAccountId));
        break;
      case PT.ERROR_RES: {
        const acc = this.accounts.get(Number(p.ctidTraderAccountId));
        const msg = `${String(p.errorCode ?? "error")}: ${String(p.description ?? "")}`;
        if (acc) acc.error = msg; else this.error = msg;
        break;
      }
    }
  }

  private request(ws: WebSocket, ctid: number) {
    this.send(ws, PT.TRADER_REQ, { ctidTraderAccountId: ctid });
    this.send(ws, PT.RECONCILE_REQ, { ctidTraderAccountId: ctid });
  }

  private poll() {
    for (const a of this.accounts.values()) this.request(this.sockets[a.isLive ? "live" : "demo"] as WebSocket, a.ctid);
  }

  snapshot() {
    return { configured: this.configured, signedIn: !!this.token, error: this.error, accounts: [...this.accounts.values()], priceFeed: this.feed() ? "connected" : "not connected" };
  }
}
