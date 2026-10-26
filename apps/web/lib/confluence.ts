import { contextScore, oiRegime, type ContextInput } from "@aplus/engine";
import type { Derivs } from "@/lib/server/derivs";
import type { Macro } from "@/lib/server/macro";

/** Confluence inputs from the derivatives and macro feeds; shared by the desks and the selector. */
export function contextInput(desk: "gold" | "btc", side: "long" | "short", d: Derivs | null | undefined, m: Macro | null | undefined): ContextInput {
  const dxy = m?.series.find((s) => s.id === "dxy"), y10 = m?.series.find((s) => s.id === "us10y"), nq = m?.series.find((s) => s.id === "nq");
  const w4 = d?.oi.windows.find((w) => w.label === "4h");
  const last4 = d?.taker.slice(-4) ?? [];
  return {
    desk, side,
    dxy: dxy ? { dir: dxy.trend, chg24h: dxy.chg24h } : null,
    us10yBp24h: y10?.chgBp24h ?? null,
    nq: nq ? { dir: nq.trend } : null,
    funding: d?.funding.last ?? null,
    oi: w4 && w4.oiChg !== null && w4.priceChg !== null ? { regime: oiRegime(w4.priceChg, w4.oiChg) } : null,
    takerRatio: last4.length ? last4.reduce((s, x) => s + x.buy, 0) / Math.max(1e-9, last4.reduce((s, x) => s + x.sell, 0)) : null,
    topLs: d?.ls.top.at(-1)?.ratio ?? null,
    cotZ: m?.cot?.z ?? null,
    corrDxy: dxy?.corr30d ?? null,
  };
}

export const confluence = (desk: "gold" | "btc", side: "long" | "short", d: Derivs | null | undefined, m: Macro | null | undefined) =>
  contextScore(contextInput(desk, side, d, m));
