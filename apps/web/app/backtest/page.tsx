"use client";

import { useState } from "react";
import type { DeskId } from "@aplus/engine";
import { Seg } from "@/components/ui";
import Lab from "@/components/views/Lab";

const DESKS: { v: DeskId; l: string }[] = [{ v: "gold", l: "Gold" }, { v: "btc", l: "Bitcoin" }, { v: "fx", l: "Forex" }, { v: "indices", l: "Indices" }];

export default function BacktestPage() {
  const [desk, setDesk] = useState<DeskId>("gold");
  return (
    <>
      <div className="page-h">
        <div><h1>Backtest Suite</h1><p>Walk-forward tests of any strategy on any market, with the gate rules you choose.</p></div>
        <div className="sp" />
        <Seg label="Market group" value={desk} onChange={setDesk} options={DESKS} />
      </div>
      <Lab key={desk} deskId={desk} />
    </>
  );
}
