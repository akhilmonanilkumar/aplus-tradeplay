/** Per-instrument copilot state machine (pure reducer). */

export type CopilotState = 'IDLE' | 'PLANNED' | 'IN_POI' | 'SWEPT' | 'SHIFTED' | 'ARMED' | 'FILLED' | 'INVALID';

export type CopilotEvent =
  | { type: 'PLAN_SAVED'; invalidation: number | null; poiCount: number }
  | { type: 'ENTER_POI' }
  | { type: 'SWEEP' }
  | { type: 'SHIFT' }
  | { type: 'GATE_PASS' }
  | { type: 'GATE_FAIL'; reason: string }
  | { type: 'FILLED' }
  | { type: 'RAN_AWAY' }
  | { type: 'WINDOW_CLOSED' }
  | { type: 'NEWS_BLOCK' }
  | { type: 'INVALIDATION_HIT' }
  | { type: 'TRADE_CLOSED'; resultR: number }
  | { type: 'NEW_DAY' };

export interface CopilotContext {
  state: CopilotState;
  aPlusTradesToday: number;
  lossesToday: number;
  maxTradesPerDay: number;
  stopAfterLosses: number;
  reason: string | null;
}

export function initialContext(maxTradesPerDay = 2, stopAfterLosses = 2): CopilotContext {
  return { state: 'IDLE', aPlusTradesToday: 0, lossesToday: 0, maxTradesPerDay, stopAfterLosses, reason: null };
}

export function capReached(ctx: CopilotContext): string | null {
  if (ctx.lossesToday >= ctx.stopAfterLosses) return `stopped after ${ctx.lossesToday} losses`;
  if (ctx.aPlusTradesToday >= ctx.maxTradesPerDay) return `daily cap ${ctx.maxTradesPerDay} A+ trades reached`;
  return null;
}

const ORDER: CopilotState[] = ['IDLE', 'PLANNED', 'IN_POI', 'SWEPT', 'SHIFTED', 'ARMED'];

function invalid(ctx: CopilotContext, reason: string): CopilotContext {
  return { ...ctx, state: 'INVALID', reason };
}

export function step(ctx: CopilotContext, ev: CopilotEvent): CopilotContext {
  if (ev.type === 'NEW_DAY') return { ...ctx, state: 'IDLE', aPlusTradesToday: 0, lossesToday: 0, reason: null };
  if (ev.type === 'TRADE_CLOSED') {
    const losses = ctx.lossesToday + (ev.resultR < 0 ? 1 : 0);
    const next = { ...ctx, lossesToday: losses, reason: null };
    const cap = capReached(next);
    return cap ? invalid(next, cap) : { ...next, state: 'PLANNED' };
  }
  if (ev.type === 'PLAN_SAVED') {
    if (ev.invalidation === null) return invalid(ctx, 'a plan without an invalidation is not allowed');
    if (ev.poiCount < 1) return invalid(ctx, 'no POIs planned');
    const cap = capReached(ctx);
    return cap ? invalid(ctx, cap) : { ...ctx, state: 'PLANNED', reason: null };
  }
  if (ev.type === 'WINDOW_CLOSED') return ctx.state === 'FILLED' ? ctx : invalid(ctx, 'session window closed');
  if (ev.type === 'NEWS_BLOCK') return ctx.state === 'FILLED' ? ctx : invalid(ctx, 'news window');
  if (ev.type === 'INVALIDATION_HIT') return ctx.state === 'FILLED' ? ctx : invalid(ctx, 'bias invalidation hit');
  if (ev.type === 'GATE_FAIL') return ctx.state === 'FILLED' ? ctx : invalid(ctx, ev.reason);
  if (ev.type === 'RAN_AWAY') return ctx.state === 'ARMED' || ctx.state === 'SHIFTED' ? invalid(ctx, 'no pullback, no trade') : ctx;

  const advance = (from: CopilotState, to: CopilotState): CopilotContext => (ctx.state === from ? { ...ctx, state: to, reason: null } : ctx);
  switch (ev.type) {
    case 'ENTER_POI': return advance('PLANNED', 'IN_POI');
    case 'SWEEP': return advance('IN_POI', 'SWEPT');
    case 'SHIFT': return advance('SWEPT', 'SHIFTED');
    case 'GATE_PASS': {
      if (ctx.state !== 'SHIFTED') return ctx;
      const cap = capReached(ctx);
      return cap ? invalid(ctx, cap) : { ...ctx, state: 'ARMED', reason: null };
    }
    case 'FILLED': return ctx.state === 'ARMED' ? { ...ctx, state: 'FILLED', aPlusTradesToday: ctx.aPlusTradesToday + 1 } : ctx;
  }
  return ctx;
}

export function progress(state: CopilotState): number {
  const i = ORDER.indexOf(state);
  return i < 0 ? (state === 'FILLED' ? ORDER.length : 0) : i;
}
