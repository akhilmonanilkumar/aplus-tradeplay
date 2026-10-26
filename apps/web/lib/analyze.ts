import { INSTRUMENTS, analyzeSetup, type Candle, type InstrumentId, type SetupAnalysis, type SetupZone } from "@aplus/engine";

/** Compatibility wrapper over the engine's setup detector (shared with autopilot and backtests). */
export type Analysis = SetupAnalysis;
export type Zone = SetupZone;

export function analyze(side: "long" | "short", htf: Candle[], poi: Candle[], ltf: Candle[], manual: Zone[] = [], instrument = "XAUUSD"): Analysis {
  const def = INSTRUMENTS[instrument as InstrumentId];
  return analyzeSetup(side, htf, poi, ltf, { manual, stopBuffer: def?.stopBuffer, now: Date.now() });
}
