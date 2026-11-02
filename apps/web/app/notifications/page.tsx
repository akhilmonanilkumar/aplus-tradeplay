"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { INSTRUMENT_IDS } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { NotificationCard, useNotifyPrefs } from "@/components/Notifications";
import { CATEGORIES, type Category, type Notification, type Severity } from "@/lib/notify";
import { Card, Empty, ErrorNote, Seg } from "@/components/ui";

/** Every notification of the last 45 days, filterable by category, severity and market. */
export default function NotificationsPage() {
  const router = useRouter();
  const { lastSeen, markSeen } = useNotifyPrefs();
  const [rows, setRows] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState<Category | "all">("all");
  const [sev, setSev] = useState<Severity | "all">("all");
  const [inst, setInst] = useState("all");

  useEffect(() => {
    let stop = false;
    const load = async () => {
      let q = supabase.from("notifications").select("*").order("id", { ascending: false }).limit(300);
      if (cat !== "all") q = q.eq("category", cat);
      if (sev !== "all") q = q.eq("severity", sev);
      if (inst !== "all") q = q.eq("instrument", inst);
      const r = await q;
      if (stop) return;
      if (r.error) setError(r.error.message); else { setError(null); setRows((r.data ?? []) as Notification[]); }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, [cat, sev, inst]);

  return (
    <>
      <ErrorNote error={error} />
      <div className="row" style={{ flexWrap: "wrap" }}>
        <div className="inp" style={{ width: 180, height: 32 }}><select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value as Category | "all")}><option value="all">Every category</option>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
        <div className="inp" style={{ width: 150, height: 32 }}><select aria-label="Market" value={inst} onChange={(e) => setInst(e.target.value)}><option value="all">Every market</option>{INSTRUMENT_IDS.map((i) => <option key={i} value={i}>{i}</option>)}</select></div>
        <Seg label="Severity" value={sev} onChange={setSev} options={[{ v: "all", l: "All" }, { v: "info", l: "Info" }, { v: "success", l: "Success" }, { v: "warn", l: "Warn" }, { v: "critical", l: "Critical" }]} />
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={markSeen}>Mark all read</button>
      </div>
      <Card>
        {rows === null ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No notifications match</Empty> : (
          <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))" }}>
            {rows.map((n) => <NotificationCard key={n.id} n={n} unread={Date.parse(n.at) > lastSeen} onOpen={(x) => x.link && router.push(x.link)} />)}
          </div>
        )}
      </Card>
    </>
  );
}
