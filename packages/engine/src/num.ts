/** Number helpers that avoid binary floating-point surprises in money maths. */

export function decimalsOf(step: number): number {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Round to `d` decimals, half away from zero. */
export function round(x: number, d = 2): number {
  const f = 10 ** d;
  return Math.sign(x) * Math.round(Math.abs(x) * f + Number.EPSILON) / f;
}

/** Floor `x` to a multiple of `step` (never rounds a position size up). */
export function floorToStep(x: number, step: number): number {
  if (!(step > 0)) throw new Error('step must be > 0');
  const d = decimalsOf(step);
  const units = Math.floor(round(x / step, 9));
  return round(units * step, d);
}

export function assertFinitePositive(name: string, v: number): void {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`);
}
