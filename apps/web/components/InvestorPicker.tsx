"use client";

import { usePathname, useRouter } from "next/navigation";
import { useMe } from "@/components/Shell";
import type { Investor } from "@/lib/types";

/** Staff-only: choose which investor's app to preview. */
export default function InvestorPicker({ investors, current }: { investors: Investor[]; current: string | null }) {
  const me = useMe();
  const router = useRouter();
  const path = usePathname();
  if (!me.isStaff) return null;
  return (
    <div className="banner info">
      <span className="dot" />
      <span>Previewing as</span>
      <select className="chip info" aria-label="Investor" value={current ?? ""} onChange={(e) => router.push(`${path}?as=${e.target.value}`)}>
        {investors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
    </div>
  );
}
