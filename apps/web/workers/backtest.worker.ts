/// <reference lib="webworker" />
import { runBacktest, type BacktestData, type InstrumentId, type StrategyParams } from "@aplus/engine";

/** Runs the walk-forward backtest off the main thread. */
self.onmessage = (e: MessageEvent<{ instrument: InstrumentId; data: BacktestData; params: Partial<StrategyParams> }>) => {
  try {
    const t0 = performance.now();
    const result = runBacktest(e.data.instrument, e.data.data, e.data.params);
    self.postMessage({ ok: true, result, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ ok: false, error: (err as Error).message });
  }
};
