import type { TradingAccount } from "@/lib/types";

export type ArenaId = "cfd" | "delta" | "coinswitch" | "fyers";

/** Which arena an account belongs to, from its venue name. Prop and CFD broker accounts sit in the CFD Arena. */
export const arenaOf = (a: Pick<TradingAccount, "venue" | "platform">): ArenaId => {
  const v = `${a.venue} ${a.platform ?? ""}`.toLowerCase();
  return v.includes("delta") ? "delta" : v.includes("coinswitch") ? "coinswitch" : v.includes("fyers") ? "fyers" : "cfd";
};
