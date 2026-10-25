"use client";

import { Suspense } from "react";
import { useInvestor } from "@/lib/useInvestor";
import { Empty, ErrorNote } from "@/components/ui";
import InvestorPicker from "@/components/InvestorPicker";
import TradeLog from "@/components/TradeLog";

function Trades() {
  const d = useInvestor();
  if (d.loading) return <Empty>Loading…</Empty>;
  return (
    <>
      <InvestorPicker investors={d.investors} current={d.investor?.id ?? null} />
      <ErrorNote error={d.error} />
      <TradeLog trades={d.trades} accounts={d.accounts} limit={1000} />
    </>
  );
}

export default function Page() { return <Suspense><Trades /></Suspense>; }
