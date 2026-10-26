import { DEFAULT_SELECTOR, INSTRUMENTS, type InstrumentId } from "@aplus/engine";

/** Best-opportunity selector settings, stored in app_settings.integrations.selector. */
export interface SelectorConfig {
  enabled: boolean;
  universe: InstrumentId[];
  minScore: number;
  allowGradeA: boolean;
  maxPerDay: number;
  /** No new pick on a desk for this long after its last pick. */
  cooldownMin: number;
  account_ids: string[];
  riskPct: number;
  /** Track every pick as paper orders on the chosen accounts (fills, stop, target, P&L). */
  paper: boolean;
}

export const DEFAULT_SELECTOR_CONFIG: SelectorConfig = {
  enabled: false,
  universe: ["XAUUSD", "XAUUSDT.P", "BTCUSDT.P", "BTCUSD", "BTCUSD.SPOT"],
  minScore: DEFAULT_SELECTOR.minScore,
  allowGradeA: false,
  maxPerDay: 3,
  cooldownMin: 90,
  account_ids: [],
  riskPct: 0.5,
  paper: true,
};

export function selectorConfig(raw: unknown): SelectorConfig {
  const r = (raw ?? {}) as Partial<SelectorConfig>;
  const universe = (r.universe ?? DEFAULT_SELECTOR_CONFIG.universe).filter((i): i is InstrumentId => i in INSTRUMENTS);
  const num = (x: unknown, d: number, lo: number, hi: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return {
    enabled: r.enabled === true,
    universe,
    minScore: num(r.minScore, DEFAULT_SELECTOR_CONFIG.minScore, 0, 100),
    allowGradeA: r.allowGradeA === true,
    maxPerDay: num(r.maxPerDay, DEFAULT_SELECTOR_CONFIG.maxPerDay, 0, 20),
    cooldownMin: num(r.cooldownMin, DEFAULT_SELECTOR_CONFIG.cooldownMin, 0, 24 * 60),
    account_ids: Array.isArray(r.account_ids) ? r.account_ids.filter((x): x is string => typeof x === "string") : [],
    riskPct: num(r.riskPct, DEFAULT_SELECTOR_CONFIG.riskPct, 0.01, 2),
    paper: r.paper !== false,
  };
}
