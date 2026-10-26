"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/market";

/** Poll a JSON API route. */
export function useApi<T>(path: string | null, everyMs = 60_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try { setData(await api<T>(path)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [path]);
  useEffect(() => {
    setData(null);
    load();
    if (!everyMs) return;
    const t = setInterval(load, everyMs);
    return () => clearInterval(t);
  }, [load, everyMs]);
  return { data, error, reload: load };
}
