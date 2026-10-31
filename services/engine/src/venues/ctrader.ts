import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { timedFetch } from "../http.js";

/**
 * cTrader Open API, read-only: balances and open positions of the prop accounts, so the CFD Arena tracks
 * what was actually placed from the alert links. Uses the JSON protocol on port 5036 and the "accounts"
 * scope; this code sends no trading messages.
 */
export const CT_HOSTS = { live: "wss://live.ctraderapi.com:5036", demo: "wss://demo.ctraderapi.com:5036" } as const;
export const PT = {
  HEARTBEAT: 51,
  APP_AUTH_REQ: 2100, APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102, ACCOUNT_AUTH_RES: 2103,
  SYMBOLS_LIST_REQ: 2114, SYMBOLS_LIST_RES: 2115,
  TRADER_REQ: 2121, TRADER_RES: 2122,
  RECONCILE_REQ: 2124, RECONCILE_RES: 2125,
  EXECUTION_EVENT: 2126,
  ERROR_RES: 2142,
  ACCOUNTS_BY_TOKEN_REQ: 2149, ACCOUNTS_BY_TOKEN_RES: 2150,
} as const;

export interface CtPosition { id: number; symbol: string; side: "long" | "short"; units: number; entry: number; sl: number | null; tp: number | null; swap: number; commission: number; openedAt: number; comment: string | null }
export interface CtAccount { ctid: number; login: number | null; isLive: boolean; balance: number | null; positions: CtPosition[]; syncedAt: number | null; error: string | null }

interface Token { access_token: string; refresh_token?: string; saved_at: number }
type Msg = { payloadType: number; clientMsgId?: string; payload?: Record<string, unknown> };

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
  error: string | null = null;

  constructor(private readonly cfg: { clientId: string; clientSecret: string; redirectUri: string; tokenFile: string }) {}

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

  private connect(env: keyof typeof CT_HOSTS) {
    if (this.sockets[env] || !this.token) return;
    const ws = new WebSocket(CT_HOSTS[env]);
    this.sockets[env] = ws;
    ws.onopen = () => this.send(ws, PT.APP_AUTH_REQ, { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret });
    ws.onmessage = (ev) => { try { this.onMessage(env, ws, JSON.parse(String(ev.data)) as Msg); } catch (e) { this.error = (e as Error).message; } };
    ws.onclose = () => { delete this.sockets[env]; setTimeout(() => this.connect(env), 15_000); };
    ws.onerror = () => { this.error = `cTrader ${env} socket error`; };
  }

  private onMessage(env: keyof typeof CT_HOSTS, ws: WebSocket, m: Msg) {
    const p = m.payload ?? {};
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
        if (acc) { acc.positions = parsePositions(p, this.symbols.get(ctid) ?? new Map()); acc.syncedAt = Date.now(); acc.error = null; }
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
    return { configured: this.configured, signedIn: !!this.token, error: this.error, accounts: [...this.accounts.values()] };
  }
}
