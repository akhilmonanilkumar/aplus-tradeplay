/**
 * Entry models from the Trade Finder Pro playbook (§6). A model is the trigger,
 * never the reason: bias and location come first (the gate's boxes 1–3).
 * Long versions are described; shorts are the mirror image.
 */

export type ModelId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';

/** Model-specific confirmation the trader (or detector) must tick. */
export interface ModelCheck {
  id: string;
  label: string;
  /** Which gate box the check belongs to. */
  box: 3 | 4 | 5 | 6;
}

export interface EntryModel {
  id: ModelId;
  name: string;
  sequence: string[];
  entry: string;
  stop: string;
  target: string;
  /** Market shift: always required, or optional when aggressive entries are enabled. */
  shift: 'required' | 'optional_if_aggressive';
  checks: ModelCheck[];
  /** Can this model ever grade A+? */
  aPlusEligible: boolean;
  /** Needs `advancedModelsAllowed`. */
  advanced: boolean;
  /** Trades against the HTF trend (needs `counterTrendAllowed`). */
  counterTrend: boolean;
  instruments?: string[];
  window?: 'london_q' | 'ny_q';
}

export const ENTRY_MODELS: Record<ModelId, EntryModel> = {
  A: {
    id: 'A', name: 'Market shift → pullback',
    sequence: ['Tap 15M POI', 'Sweep internal liquidity (V-shape)', '5M body close beyond last LH / HL', 'Pull back into the shift zone'],
    entry: 'Limit at the 5M zone that caused the shift', stop: 'Beyond that zone or the sweep wick', target: 'Next 15M swing / opposing zone',
    shift: 'required', checks: [],
    aPlusEligible: true, advanced: false, counterTrend: false,
  },
  B: {
    id: 'B', name: 'Flip zone',
    sequence: ['Tap POI + sweep', 'Opposing LTF zone reacts, then fails and breaks', 'Market shift'],
    entry: 'Limit at the flip zone', stop: 'Beyond the flip zone', target: 'Next 15M swing / opposing zone',
    shift: 'required', checks: [{ id: 'failed_opposing_zone', label: 'Opposing zone failed and broke', box: 5 }],
    aPlusEligible: true, advanced: false, counterTrend: false,
  },
  C: {
    id: 'C', name: 'Sweep → OB → FVG',
    sequence: ['Liquidity sweep (the trap)', 'Displacement leaves an order block', 'FVG inside / next to the OB'],
    entry: 'Limit at the FVG (or OB if none)', stop: 'Beyond the OB or protected level', target: 'Next 15M swing — 3R minimum',
    shift: 'required', checks: [{ id: 'ob_fvg', label: 'Displacement left an OB with an FVG', box: 3 }],
    aPlusEligible: true, advanced: false, counterTrend: false,
  },
  D: {
    id: 'D', name: 'Institutional precision',
    sequence: ['Institutional zone (protected level that swept liquidity)', 'First tap = inducement', 'Sweep of the first tap'],
    entry: 'After the sweep of the initial mitigation', stop: 'Beyond the new protected level', target: 'Opposing institutional zone',
    shift: 'optional_if_aggressive', checks: [{ id: 'first_tap_swept', label: 'First tap swept (inducement taken)', box: 4 }],
    aPlusEligible: true, advanced: false, counterTrend: false,
  },
  E: {
    id: 'E', name: 'Gold sweep entry',
    sequence: ['1H and 15M aligned', 'Mark liquidity and 15M POIs', 'Price reaches a POI', 'Sweep', 'Shift (conservative)'],
    entry: 'Conservative: shift + pullback · aggressive: on the sweep candle', stop: 'Beyond the protected level', target: 'Nearest 15M swing (≈3R)',
    shift: 'optional_if_aggressive', checks: [],
    aPlusEligible: true, advanced: false, counterTrend: false, instruments: ['XAUUSD'],
  },
  F: {
    id: 'F', name: 'Asia sweep',
    sequence: ['Mark Asia high / low', 'London window sweeps one side with the bias', 'LTF shift'],
    entry: 'Shift zone', stop: 'Beyond the sweep', target: 'Opposite side of the range / next HTF level',
    shift: 'required', checks: [{ id: 'asia_swept', label: 'Asia high / low swept', box: 4 }],
    aPlusEligible: true, advanced: false, counterTrend: false, window: 'london_q',
  },
  G: {
    id: 'G', name: 'Counter-trend pullback scalp',
    sequence: ['HTF over-extended in premium / discount', '1M fractal shift + internal BOS', 'POI tap + inducement swept'],
    entry: '1M zone', stop: 'Beyond the protected level', target: 'Nearest 5M zone only',
    shift: 'required', checks: [{ id: 'fractal_shift', label: '1M fractal shift + internal BOS', box: 5 }],
    aPlusEligible: false, advanced: true, counterTrend: true,
  },
  H: {
    id: 'H', name: 'Sniper / fractal shift',
    sequence: ['Shift with no pullback', 'Drop to 1M: fractal shift', 'Tiny extreme / flip zone'],
    entry: '1M zone, scale in on internal BOS pullbacks', stop: 'Beyond the 1M zone (very tight)', target: 'Far targets (1:5+)',
    shift: 'required', checks: [{ id: 'fractal_shift', label: '1M fractal shift', box: 5 }],
    aPlusEligible: false, advanced: true, counterTrend: false,
  },
  I: {
    id: 'I', name: 'Post-news',
    sequence: ['Let the spike happen', 'Wait 30–60 min', 'Sweep, reclaim or return to a POI'],
    entry: 'Normal plan from there', stop: 'Structural', target: 'Structural',
    shift: 'required', checks: [],
    aPlusEligible: true, advanced: true, counterTrend: false,
  },
};

export const MODEL_IDS = Object.keys(ENTRY_MODELS) as ModelId[];

/** Legacy alias used by older rows. */
export function normalizeModel(id: string | null | undefined): ModelId {
  if (id === 'CT1') return 'G';
  return (id && id in ENTRY_MODELS ? id : 'A') as ModelId;
}
