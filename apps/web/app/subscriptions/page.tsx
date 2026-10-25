"use client";

import { Fragment, useMemo, useState } from "react";
import { churnRate, mrr } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { Plan, TgEvent, TgMember, TgPost, TrackedLink } from "@/lib/types";
import { dateShort, money, num, pct, toNum } from "@/lib/fmt";
import { Bar, Card, Chip, Empty, ErrorNote, Note, Seg, Table } from "@/components/ui";

const DAY = 86_400_000, WEEK = 7 * DAY;
const SOURCES = ["instagram_bio", "instagram_reels", "youtube", "free_group", "referral", "direct"];
const srcLabel = (s: string | null | undefined) => (s ?? "direct").replace("instagram_", "Instagram · ").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
type Ev = TgEvent & { payload?: Record<string, unknown> };

/** Paid-access windows per member from payment/renewal events, cut short by leave/removed. */
function windows(events: Ev[], plans: Plan[], members: TgMember[]) {
  const months = (m: TgMember) => plans.find((p) => p.id === m.plan_id)?.months ?? 1;
  const byMember = new Map<string, Ev[]>();
  for (const e of events) if (e.tg_member_id && e.chat === "vip") byMember.set(e.tg_member_id, [...(byMember.get(e.tg_member_id) ?? []), e]);
  const out = new Map<string, { from: number; to: number }[]>();
  for (const m of members) {
    const evs = (byMember.get(m.id) ?? []).sort((a, b) => +new Date(a.at) - +new Date(b.at));
    const w: { from: number; to: number }[] = [];
    for (const e of evs) {
      const t = +new Date(e.at);
      if (e.type === "payment" || e.type === "renewal") {
        const last = w[w.length - 1];
        const end = t + months(m) * 30 * DAY;
        if (last && t <= last.to) last.to = Math.max(last.to, end); else w.push({ from: t, to: end });
      } else if ((e.type === "leave" || e.type === "removed") && w.length) {
        const last = w[w.length - 1]!; if (t < last.to) last.to = t;
      }
    }
    out.set(m.id, w);
  }
  return out;
}
const activeAt = (w: { from: number; to: number }[] | undefined, t: number) => !!w?.some((x) => x.from <= t && t < x.to);

export default function Subscriptions() {
  const members = useRows<TgMember>({ table: "tg_members", order: "first_seen", limit: 10000 });
  const events = useRows<Ev>({ table: "tg_events", order: "at", ascending: true, limit: 20000 });
  const posts = useRows<TgPost>({ table: "tg_posts", order: "created_at", limit: 20 });
  const plans = useRows<Plan>({ table: "subscription_plans", order: "months", ascending: true });
  const links = useRows<TrackedLink>({ table: "tracked_links", order: "created_at" });
  const clicks = useRows<{ link_id: string; at: string }>({ table: "link_clicks", select: "link_id,at", order: "at", limit: 50000 });
  const [touch, setTouch] = useState<"first" | "last">("first");
  const [mf, setMf] = useState<"all" | "expiring" | "lapsed">("all");
  const [editPrices, setEditPrices] = useState(false);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [np, setNp] = useState({ name: "", price: "", months: "1" });
  const [linkModal, setLinkModal] = useState(false);
  const [nl, setNl] = useState({ slug: "", source: "instagram_bio", campaign: "", target: "" });
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const m = members.rows ?? [], ev = events.rows ?? [], pl = plans.rows ?? [];
  const now = Date.now();
  const w = useMemo(() => windows(ev, pl, m), [ev, pl, m]);
  const paidNow = m.filter((x) => activeAt(w.get(x.id), now) || x.status === "active" || x.status === "expiring");
  const activeOn = (p: Plan) => paidNow.filter((x) => x.plan_id === p.id).length;
  const monthly = mrr(pl.map((p) => ({ price: Number(p.price_inr), months: p.months, active: activeOn(p) })));
  const vip = ev.filter((e) => e.chat === "vip");
  const since30 = now - 30 * DAY;
  const churned30 = vip.filter((e) => (e.type === "leave" || e.type === "removed") && +new Date(e.at) >= since30).length;
  const firstPay = new Map<string, number>();
  for (const e of vip) if ((e.type === "payment") && e.tg_member_id && !firstPay.has(e.tg_member_id)) firstPay.set(e.tg_member_id, +new Date(e.at));
  const new30 = Array.from(firstPay.values()).filter((t) => t >= since30).length;
  const churn = churnRate(Math.max(0, paidNow.length - new30 + churned30), new30, churned30);
  const expiring = m.filter((x) => x.paid_until && +new Date(x.paid_until) > now && +new Date(x.paid_until) - now < 7 * DAY);
  const freeMembers = m.filter((x) => x.status === "free").length;

  // 12-week series
  const weeks = Array.from({ length: 12 }, (_, i) => now - (11 - i) * WEEK);
  const series = weeks.map((t) => ({
    active: m.filter((x) => activeAt(w.get(x.id), t)).length,
    news: Array.from(firstPay.values()).filter((p) => p > t - WEEK && p <= t).length,
    churn: vip.filter((e) => (e.type === "leave" || e.type === "removed") && +new Date(e.at) > t - WEEK && +new Date(e.at) <= t).length,
  }));
  const maxY = Math.max(1, ...series.map((s) => Math.max(s.active, s.news, s.churn)));
  const W = 800, H = 220, bw = W / 12;
  const y = (v: number) => H - 8 - (v / maxY) * (H - 20);
  const line = series.map((s, i) => `${i ? "L" : "M"}${(i * bw + bw / 2).toFixed(1)},${y(s.active).toFixed(1)}`).join(" ");
  const bars = (k: "news" | "churn", off: number) => series.map((s, i) => { const x = i * bw + bw / 2 + off, h = (s[k] / maxY) * (H - 20); return `M${x},${H - 8}h10v${-h}h-10z`; }).join(" ");

  // funnel 90d
  const since90 = now - 90 * DAY;
  const cl90 = (clicks.rows ?? []).filter((c) => +new Date(c.at) >= since90);
  const funnel = [
    { l: "Link clicks", v: cl90.length },
    { l: "Joined free", v: ev.filter((e) => e.chat === "free" && e.type === "join" && +new Date(e.at) >= since90).length },
    { l: "Paid", v: Array.from(firstPay.values()).filter((t) => t >= since90).length },
    { l: "Renewed", v: vip.filter((e) => e.type === "renewal" && +new Date(e.at) >= since90).length },
  ];
  const fmax = Math.max(1, ...funnel.map((f) => f.v));

  // sources
  const linkSrc = new Map((links.rows ?? []).map((l) => [l.id, l.source]));
  const lastSrc = new Map<string, string>();
  for (const e of vip) if (e.type === "payment" && e.tg_member_id && typeof e.payload?.source === "string") lastSrc.set(e.tg_member_id, e.payload.source as string);
  const srcOf = (x: TgMember) => (touch === "last" ? lastSrc.get(x.id) ?? x.source : x.source) ?? "direct";
  const allSrc = Array.from(new Set([...SOURCES, ...m.map(srcOf)]));
  const srcRows = allSrc.map((s) => {
    const ms = m.filter((x) => srcOf(x) === s && +new Date(x.first_seen) >= since90);
    const ids = new Set(ms.map((x) => x.id));
    const paid = ms.filter((x) => firstPay.has(x.id)).length;
    const c = cl90.filter((k) => linkSrc.get(k.link_id) === s).length;
    const rev = vip.filter((e) => e.tg_member_id && ids.has(e.tg_member_id) && (e.type === "payment" || e.type === "renewal")).reduce((a, e) => a + Number(e.amount_inr ?? 0), 0);
    return { s, clicks: c, joins: ms.length, paid, rev };
  }).filter((r) => r.clicks || r.joins);
  const totalPaid = Math.max(1, srcRows.reduce((a, r) => a + r.paid, 0));

  // 7-day tiles
  const since7 = now - 7 * DAY;
  const e7 = ev.filter((e) => +new Date(e.at) >= since7);
  const tiles = [
    { l: "VIP joins", v: e7.filter((e) => e.chat === "vip" && e.type === "join").length, c: "up" },
    { l: "VIP leaves", v: e7.filter((e) => e.chat === "vip" && (e.type === "leave" || e.type === "removed")).length, c: "down" },
    { l: "Payments", v: e7.filter((e) => e.type === "payment").length, c: "" },
    { l: "Renewals", v: e7.filter((e) => e.type === "renewal").length, c: "" },
    { l: "Failed payments", v: e7.filter((e) => e.type === "payment_failed").length, c: "warn" },
    { l: "Free group joins", v: e7.filter((e) => e.chat === "free" && e.type === "join").length, c: "" },
  ];

  // cohorts by month of first payment
  const cohorts = Array.from({ length: 5 }, (_, i) => { const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - (4 - i)); d.setUTCHours(0, 0, 0, 0); return d; });
  const cohortRows = cohorts.map((start) => {
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    const ids = Array.from(firstPay.entries()).filter(([, t]) => t >= +start && t < +end);
    const cells = [1, 2, 3, 4].map((n) => {
      const at = +end + (n - 1) * 30 * DAY;
      if (at > now || !ids.length) return null;
      return ids.filter(([id]) => activeAt(w.get(id), at)).length / ids.length;
    });
    return { label: start.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }), n: ids.length, cells };
  });

  const memberRows = m.filter((x) => mf === "all" || (mf === "expiring" ? expiring.includes(x) : x.status === "lapsed" || x.status === "removed")).slice(0, 200);
  const lastVia = (id: string) => { const e = [...vip].reverse().find((x) => x.tg_member_id === id && (x.type === "payment" || x.type === "renewal")); return (e?.payload?.via as string | undefined) ?? (e ? "—" : "—"); };

  const savePrices = async () => {
    for (const [id, v] of Object.entries(prices)) { const n = toNum(v); if (n >= 0) await supabase.from("subscription_plans").update({ price_inr: n }).eq("id", id); }
    setEditPrices(false); setPrices({}); plans.reload();
  };
  const addPlan = async () => {
    const price = toNum(np.price), months = Math.round(toNum(np.months));
    if (!np.name.trim() || !(price >= 0) || !(months >= 1 && months <= 12)) return setMsg({ ok: false, t: "Plan name, price and 1–12 months" });
    const { error } = await supabase.from("subscription_plans").insert({ name: np.name.trim(), price_inr: price, months });
    if (error) return setMsg({ ok: false, t: error.message });
    setNp({ name: "", price: "", months: "1" }); plans.reload();
  };
  const addLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const slug = nl.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!slug || !/^https:\/\//.test(nl.target)) return setMsg({ ok: false, t: "Slug and an https target are required" });
    const { error } = await supabase.from("tracked_links").insert({ slug, source: nl.source, campaign: nl.campaign || null, target_url: nl.target });
    if (error) return setMsg({ ok: false, t: error.message });
    setLinkModal(false); setNl({ slug: "", source: "instagram_bio", campaign: "", target: "" }); links.reload();
  };

  return (
    <>
      <ErrorNote error={members.error || events.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(170px, 100%), 1fr))" }}>
        {[
          { l: "Paid members", v: String(paidNow.length), n: `${new30} new · 30 d`, c: "" },
          { l: "MRR", v: money(monthly, "INR", 0), n: "quarterly ÷ 3", c: "acc" },
          { l: "ARPU", v: paidNow.length ? money(monthly / paidNow.length, "INR", 0) : "—", n: "per paid member / month", c: "" },
          { l: "Churn · 30 d", v: pct(churn, 1), n: `${churned30} left`, c: churn > 0.1 ? "down" : "" },
          { l: "Expiring · 7 d", v: String(expiring.length), n: "renewal reminders", c: expiring.length ? "warn" : "" },
          { l: "Free group", v: String(freeMembers), n: "not paying", c: "" },
        ].map((k) => <div key={k.l} className="card"><div className="lbl">{k.l}</div><div className={`kv sm ${k.c}`} style={{ marginTop: 4 }}>{k.v}</div><div className="faint" style={{ fontSize: 11 }}>{k.n}</div></div>)}
      </section>

      <section className="g12">
        <Card span={8} title="Active paid members · last 12 weeks" right={<span className="row" style={{ fontSize: 12, gap: 12 }}><span className="row"><span className="dot acc" />Active</span><span className="row"><span className="dot up" />New</span><span className="row"><span className="dot down" />Churned</span></span>}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 220, display: "block" }} role="img" aria-label="Active paid members by week">
            <path d={bars("news", -11)} fill="var(--up)" opacity=".55" />
            <path d={bars("churn", 1)} fill="var(--down)" opacity=".55" />
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="between mono faint" style={{ fontSize: 11 }}><span>W1 · {series[0]!.active} active</span><span>W12 · {series[11]!.active} active</span></div>
        </Card>
        <Card span={4} title="Funnel · 90 days">
          <div className="col" style={{ gap: 8 }}>
            {funnel.map((f) => (
              <div key={f.l} style={{ display: "grid", gridTemplateColumns: "110px minmax(0,1fr) 60px", gap: 10, alignItems: "center", fontSize: 12.5 }}>
                <span className="muted">{f.l}</span><div><i style={{ display: "block", height: 22, borderRadius: 7, background: "var(--accent)", width: `${(f.v / fmax) * 100}%` }} /></div><span className="mono" style={{ textAlign: "right" }}>{f.v}</span>
              </div>
            ))}
          </div>
        </Card>
      </section>

      <section className="card flush">
        <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Member sources · 90 days</h3><span className="sp" /><button className="btn sm" onClick={() => setLinkModal(true)}>Tracked links · {(links.rows ?? []).length}</button><Seg label="Attribution" value={touch} onChange={setTouch} options={[{ v: "first", l: "First touch" }, { v: "last", l: "Last touch" }]} /></div>
        {srcRows.length === 0 ? <div style={{ padding: 16 }}><Empty>No tracked joins yet</Empty></div> : (
          <Table head={["Source", "Link clicks", "Joined", "Paid", "Click → paid", "Revenue", "Share of paid"]} right={[1, 2, 3, 4, 5]}>
            {srcRows.map((r) => (
              <tr key={r.s}><td><b style={{ fontWeight: 500 }}>{srcLabel(r.s)}</b></td><td className="r mono">{r.clicks || "—"}</td><td className="r mono">{r.joins}</td><td className="r mono">{r.paid}</td><td className="r mono">{r.clicks ? pct(r.paid / r.clicks, 1) : "—"}</td><td className="r mono">{money(r.rev, "INR", 0)}</td><td style={{ width: "22%" }}><Bar pct={(r.paid / totalPaid) * 100} /></td></tr>
            ))}
          </Table>
        )}
      </section>

      <section className="g12">
        <Card span={4} title="Channel activity · 7 days">
          <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            {tiles.map((t) => <div key={t.l}><div className="lbl">{t.l}</div><b className={`mono ${t.v ? t.c : ""}`}>{t.v}</b></div>)}
          </div>
        </Card>
        <div className="card flush s8">
          <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Post engagement</h3></div>
          {(posts.rows ?? []).length === 0 ? <div style={{ padding: 16 }}><Empty>No posts yet</Empty></div> : (
            <Table head={["Post", "Where", "Views", "Reactions", "Link clicks", "Upgrades in 24h"]} right={[2, 3, 4, 5]}>
              {(posts.rows ?? []).map((p) => {
                const t = p.sent_at ? +new Date(p.sent_at) : null;
                const up = t ? Array.from(firstPay.values()).filter((x) => x >= t && x < t + DAY).length : 0;
                return <tr key={p.id}><td>{p.kind}</td><td>{p.destination === "both" ? "VIP + free" : p.destination === "vip" ? "VIP" : "Free group"}</td><td className="r mono">{p.views !== null ? num(p.views, 0) : "—"}</td><td className="r mono">{p.reactions ?? "—"}</td><td className="r mono">{p.clicks ?? "—"}</td><td className="r mono">{t ? up : "—"}</td></tr>;
              })}
            </Table>
          )}
        </div>
      </section>

      <section className="g12">
        <Card span={5} title="Plans" right={editPrices ? <><button className="btn sm" onClick={() => setEditPrices(false)}>Cancel</button><button className="btn pri sm" onClick={savePrices}>Save</button></> : <button className="btn sm" onClick={() => setEditPrices(true)}>Edit prices</button>}>
          <Table head={["Plan", "Price", "Active", "MRR", "Billing"]} right={[1, 2, 3]}>
            {pl.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="r mono">{editPrices ? <input className="mono" style={{ width: 90, background: "var(--surface-2)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "2px 6px", textAlign: "right" }} value={prices[p.id] ?? String(p.price_inr)} onChange={(e) => setPrices({ ...prices, [p.id]: e.target.value })} /> : money(Number(p.price_inr), "INR", 0)}</td>
                <td className="r mono">{activeOn(p)}</td>
                <td className="r mono">{money((Number(p.price_inr) / p.months) * activeOn(p), "INR", 0)}</td>
                <td className="muted">{p.months === 1 ? "Monthly" : `Every ${p.months} months`}</td>
              </tr>
            ))}
          </Table>
          <div className="row" style={{ marginTop: 10 }}>
            <div className="inp txt" style={{ flex: 2 }}><input aria-label="Plan name" placeholder="New plan" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} /></div>
            <div className="inp" style={{ flex: 1 }}><input aria-label="Price" inputMode="decimal" placeholder="₹" value={np.price} onChange={(e) => setNp({ ...np, price: e.target.value })} /></div>
            <div className="inp" style={{ width: 70 }}><input aria-label="Months" inputMode="numeric" value={np.months} onChange={(e) => setNp({ ...np, months: e.target.value })} /><span className="u">mo</span></div>
            <button className="btn sm" onClick={addPlan}>Add</button>
          </div>
        </Card>
        <Card span={7} title="Retention by joining month" right={<span className="faint" style={{ fontSize: 12 }}>% still paying after N months</span>}>
          <div style={{ display: "grid", gridTemplateColumns: "90px repeat(4, minmax(0, 1fr))", gap: 4, fontSize: 11.5 }}>
            {["Cohort", "M1", "M2", "M3", "M4"].map((h) => <span key={h} className="faint" style={{ height: 30, display: "grid", placeItems: "center" }}>{h}</span>)}
            {cohortRows.map((c) => (
              <Fragment key={c.label}>
                <span className="mono" style={{ height: 30, display: "grid", placeItems: "center" }}>{c.label} · {c.n}</span>
                {c.cells.map((v, i) => <span key={`${c.label}${i}`} className="mono" style={{ height: 30, display: "grid", placeItems: "center", borderRadius: 7, background: v === null ? "var(--surface-2)" : `color-mix(in srgb, var(--accent) ${Math.round(v * 70) + 8}%, var(--surface-2))`, color: v !== null && v > 0.6 ? "var(--on-accent)" : "var(--muted)" }}>{v === null ? "—" : pct(v, 0)}</span>)}
              </Fragment>
            ))}
          </div>
        </Card>
      </section>

      <section className="card flush">
        <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Members</h3><span className="sp" /><Seg label="Filter" value={mf} onChange={setMf} options={[{ v: "all", l: "All" }, { v: "expiring", l: "Expiring" }, { v: "lapsed", l: "Lapsed" }]} /></div>
        {memberRows.length === 0 ? <div style={{ padding: 16 }}><Empty>No members</Empty></div> : (
          <Table head={["Member", "Source", "Plan", "Paid via", "Since", "Renews", "Telegram access", "Status"]}>
            {memberRows.map((x) => {
              const exp = expiring.includes(x);
              const days = x.paid_until ? Math.ceil((+new Date(x.paid_until) - now) / DAY) : null;
              return (
                <tr key={x.id}>
                  <td>{x.username ? `@${x.username}` : <span className="mono faint">{x.telegram_user_id}</span>}</td>
                  <td className="muted">{srcLabel(x.source)}</td>
                  <td>{pl.find((p) => p.id === x.plan_id)?.name ?? (x.status === "free" ? "Free group" : "—")}</td>
                  <td>{lastVia(x.id)}</td>
                  <td className="mono faint">{dateShort(x.first_seen)}</td>
                  <td className="mono">{dateShort(x.paid_until)}</td>
                  <td>{x.status === "active" || x.status === "expiring" ? "In channel" : x.status === "free" ? "Group member" : "Removed by bot"}</td>
                  <td><Chip tone={exp ? "warn" : x.status === "active" ? "up" : x.status === "lapsed" || x.status === "removed" ? "down" : ""}>{exp && days !== null ? `Expires in ${days} d` : x.status.replace(/^\w/, (c) => c.toUpperCase())}</Chip></td>
                </tr>
              );
            })}
          </Table>
        )}
      </section>

      {linkModal && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Tracked links">
          <div className="card">
            <div className="ch"><h3>Tracked links</h3><span className="sp" /><button className="btn ghost sm" onClick={() => setLinkModal(false)}>Close</button></div>
            {(links.rows ?? []).map((l) => (
              <div key={l.id} className="between" style={{ padding: "7px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
                <span className="mono">/{l.slug}</span><span className="row"><Chip>{srcLabel(l.source)}</Chip><span className="mono faint">{(clicks.rows ?? []).filter((c) => c.link_id === l.id).length} clicks</span></span>
              </div>
            ))}
            <form onSubmit={addLink} className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))", marginTop: 12 }}>
              <label className="fld"><span>Slug</span><div className="inp"><input value={nl.slug} placeholder="ig-bio" onChange={(e) => setNl({ ...nl, slug: e.target.value })} /></div></label>
              <label className="fld"><span>Source</span><div className="inp"><select value={nl.source} onChange={(e) => setNl({ ...nl, source: e.target.value })}>{SOURCES.map((s) => <option key={s} value={s}>{srcLabel(s)}</option>)}</select></div></label>
              <label className="fld"><span>Campaign</span><div className="inp txt"><input value={nl.campaign} onChange={(e) => setNl({ ...nl, campaign: e.target.value })} /></div></label>
              <label className="fld"><span>Target</span><div className="inp txt"><input value={nl.target} placeholder="https://t.me/+…" onChange={(e) => setNl({ ...nl, target: e.target.value })} /></div></label>
              <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end" }}><button className="btn pri sm">Add link</button></div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
