/** Engine host configuration, read once from the environment. Every trading switch defaults to off. */

const env = (k: string, d = "") => (process.env[k] ?? d).trim();
const list = (k: string, d: string) => env(k, d).split(",").map((s) => s.trim()).filter(Boolean);
const on = (k: string) => env(k).toLowerCase() === "on";

export type DeltaEnv = "testnet" | "production";

export const config = {
  port: Number(env("PORT", "8787")),
  /** Shared with the web app (ENGINE_SECRET there). Every non-health request is HMAC-signed with it. */
  secret: env("ENGINE_SECRET") || env("DELTA_RELAY_SECRET"),
  /** Shown on the Integrations page so the whitelisted IP is visible. */
  publicIp: env("PUBLIC_IP"),
  databaseUrl: env("DATABASE_URL"),
  /** How long trades stay in memory for the flow views, ms. */
  memoryMs: Number(env("MEMORY_MINUTES", "120")) * 60_000,

  delta: {
    env: (env("DELTA_ENV") === "production" ? "production" : "testnet") as DeltaEnv,
    keys: {
      production: { key: env("DELTA_API_KEY"), secret: env("DELTA_API_SECRET") },
      testnet: { key: env("DELTA_TESTNET_API_KEY"), secret: env("DELTA_TESTNET_API_SECRET") },
    },
    /** Market data always comes from production (the real market). */
    symbols: list("DELTA_SYMBOLS", "BTCUSD,ETHUSD,XAUTUSD"),
    /** Public socket channel names; Delta is migrating l2_updates → ob_updates and all_trades → trades. */
    channels: list("DELTA_WS_CHANNELS", "l2_updates,all_trades,v2/ticker"),
    execution: on("DELTA_EXECUTION"),
  },

  coinswitch: {
    apiKey: env("COINSWITCH_API_KEY"),
    /** Ed25519 private key seed, hex (32 bytes). */
    secretHex: env("COINSWITCH_SECRET_KEY"),
    symbols: list("COINSWITCH_SYMBOLS", "BTCUSDT,ETHUSDT"),
    execution: on("COINSWITCH_EXECUTION"),
  },

  fyers: {
    appId: env("FYERS_APP_ID"),
    secretId: env("FYERS_SECRET_ID"),
    redirectUri: env("FYERS_REDIRECT_URI"),
    pin: env("FYERS_PIN"),
    tokenFile: env("FYERS_TOKEN_FILE", "/data/fyers-token.json"),
    symbols: list("FYERS_SYMBOLS", "NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX,BSE:SENSEX-INDEX"),
    execution: on("FYERS_EXECUTION"),
  },

  ctrader: {
    clientId: env("CTRADER_CLIENT_ID"),
    clientSecret: env("CTRADER_CLIENT_SECRET"),
    redirectUri: env("CTRADER_REDIRECT_URI"),
    tokenFile: env("CTRADER_TOKEN_FILE", "/data/ctrader-token.json"),
  },
} as const;

/** Clock budgets per venue, ms: |offset| and p95 round trip must stay inside to sign orders. */
export const CLOCK_BUDGET_MS = { delta: 1500, coinswitch: 1000, fyers: 2000 } as const;
