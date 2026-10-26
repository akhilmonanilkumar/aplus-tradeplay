"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Q = { table: string; select?: string; order?: string; ascending?: boolean; limit?: number; eq?: [string, string | number | boolean]; notNull?: string; inList?: [string, string[]] };

/** Load rows from one table (RLS decides what the signed-in user can see). */
export function useRows<T>(q: Q) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(q);
  const load = useCallback(async () => {
    let query = supabase.from(q.table).select(q.select ?? "*");
    if (q.eq) query = query.eq(q.eq[0], q.eq[1]);
    if (q.notNull) query = query.not(q.notNull, "is", null);
    if (q.inList) query = query.in(q.inList[0], q.inList[1]);
    if (q.order) query = query.order(q.order, { ascending: q.ascending ?? false });
    if (q.limit) query = query.limit(q.limit);
    const { data, error } = await query;
    if (error) setError(error.message);
    else { setError(null); setRows((data ?? []) as T[]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { load(); }, [load]);
  return { rows, error, reload: load };
}
