import { INSTRUMENTS, INSTRUMENT_IDS, type Candle, type InstrumentId, type Tf } from "@aplus/engine";
import { supabase } from "@/lib/supabase";

export type { Tf };
export const INSTRUMENT_TF: Record<string, { htf: Tf; poi: Tf; ltf: Tf; label: string }> = Object.fromEntries(
  INSTRUMENT_IDS.map((id) => {
    const d = INSTRUMENTS[id];
    return [id, { htf: d.htf, poi: d.poi, ltf: d.ltf, label: `${d.htf.toUpperCase()} · ${d.poi.toUpperCase()} · ${d.ltf.toUpperCase()}` }];
  }),
);

export interface CandleSet { candles: Candle[]; forming: Candle | null; source: string; approx: boolean; note?: string }

/** GET a JSON API route; throws the route's error message. */
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, cache: "no-store" });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

/** POST to a staff-only API route with the signed-in user's token. */
export async function staffPost<T>(path: string, body: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${data.session?.access_token ?? ""}` }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

export async function staffGet<T>(path: string): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(path, { headers: { authorization: `Bearer ${data.session?.access_token ?? ""}` }, cache: "no-store" });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

export const fetchCandles = (i: InstrumentId | string, tf: Tf, limit = 300, signal?: AbortSignal) =>
  api<CandleSet>(`/api/market/candles?i=${encodeURIComponent(i)}&tf=${tf}&limit=${limit}`, signal);

export const fetchHistory = (i: InstrumentId, tf: Tf, from: number, to: number) =>
  api<CandleSet>(`/api/market/history?i=${encodeURIComponent(i)}&tf=${tf}&from=${from}&to=${to}`);
