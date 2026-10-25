/** Realised R from price: signed move ÷ initial risk distance. */
export function realizedR(side: "long" | "short", entry: number, stop: number, exit: number): number | null {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return ((side === "long" ? 1 : -1) * (exit - entry)) / risk;
}
