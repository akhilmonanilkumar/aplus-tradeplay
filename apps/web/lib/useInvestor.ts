"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useMe } from "@/components/Shell";
import type { Investor, Payout, PropPurchase, Trade, TradingAccount } from "@/lib/types";

export interface InvestorData {
  investor: Investor | null;
  investors: Investor[];
  accounts: TradingAccount[];
  trades: Trade[];
  payouts: Payout[];
  purchases: PropPurchase[];
  loading: boolean;
  error: string | null;
}

/**
 * Investor-app data. An investor sees only their own rows (RLS); staff previewing
 * pass ?as=<investorId> and the same filters are applied explicitly.
 */
export function useInvestor(): InvestorData {
  const me = useMe();
  const params = useSearchParams();
  let asId = params.get("as");
  try {
    if (asId) sessionStorage.setItem("aplus.as", asId);
    else if (typeof window !== "undefined") asId = sessionStorage.getItem("aplus.as");
  } catch { /* storage unavailable */ }
  const [d, setD] = useState<InvestorData>({ investor: null, investors: [], accounts: [], trades: [], payouts: [], purchases: [], loading: true, error: null });

  useEffect(() => {
    let live = true;
    (async () => {
      const invs = await supabase.from("investors").select("*").order("name");
      if (invs.error) return live && setD((x) => ({ ...x, loading: false, error: invs.error.message }));
      const all = (invs.data ?? []) as Investor[];
      const id = me.isStaff ? asId ?? all[0]?.id ?? null : me.investorId;
      const investor = all.find((i) => i.id === id) ?? null;
      if (!investor) return live && setD({ investor: null, investors: all, accounts: [], trades: [], payouts: [], purchases: [], loading: false, error: null });
      const [acc, pay, pp] = await Promise.all([
        supabase.from("trading_accounts").select("*").eq("investor_id", investor.id).order("created_at"),
        supabase.from("payouts").select("*").eq("investor_id", investor.id).order("created_at", { ascending: false }),
        supabase.from("prop_purchases").select("*").eq("investor_id", investor.id).order("created_at"),
      ]);
      const accounts = (acc.data ?? []) as TradingAccount[];
      const ids = accounts.map((a) => a.id);
      const tr = ids.length ? await supabase.from("trades").select("*").in("account_id", ids).order("opened_at", { ascending: false }).limit(2000) : { data: [], error: null };
      if (live) setD({ investor, investors: all, accounts, trades: (tr.data ?? []) as Trade[], payouts: (pay.data ?? []) as Payout[], purchases: (pp.data ?? []) as PropPurchase[], loading: false, error: acc.error?.message ?? pay.error?.message ?? tr.error?.message ?? null });
    })();
    return () => { live = false; };
  }, [me.isStaff, me.investorId, asId]);
  return d;
}
