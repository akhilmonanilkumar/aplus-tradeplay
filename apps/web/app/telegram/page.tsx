"use client";

import { useState } from "react";
import { churnRate, mrr } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import type { Plan, TgEvent, TgMember, TgPost, TrackedLink } from "@/lib/types";
import { dateShort, money, pct, toNum } from "@/lib/fmt";
import { Badge, Bars, Card, Empty, ErrorNote, Field, Kpi, PageHead, Table } from "@/components/ui";

const SOURCES = ["instagram_bio", "instagram_reels", "youtube", "free_group", "referral", "direct"];
const DAY = 86_400_000;
const STATUS_TONE: Record<TgMember["status"], string> = { active: "up", expiring: "warn", lapsed: "down", removed: "mute", free: "mute" };

export default function Telegram() {
  const members = useRows<TgMember>({ table: "tg_members", order: "first_seen", limit: 5000 });
  const plans = useRows<Plan>({ table: "subscription_plans", order: "months", ascending: true });
  const links = useRows<TrackedLink>({ table: "tracked_links", order: "created_at" });
  const clicks = useRows<{ link_id: string; at: string }>({ table: "link_clicks", select: "link_id,at", order: "at", limit: 20000 });
  const events = useRows<TgEvent>({ table: "tg_events", order: "at", limit: 5000 });
  const posts = useRows<TgPost>({ table: "tg_posts", order: "created_at", limit: 30 });
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState({ name: "", price: "", months: "1" });
  const [link, setLink] = useState({ slug: "", source: "instagram_bio", campaign: "", target: "" });

  const m = members.rows ?? [];
  const paidNow = m.filter((x) => x.status === "active" || x.status === "expiring");
  const planRows = plans.rows ?? [];
  const monthly = mrr(planRows.map((p) => ({ price: Number(p.price_inr), months: p.months, active: paidNow.filter((x) => x.plan_id === p.id).length })));

  const since = Date.now() - 30 * DAY;
  const ev = events.rows ?? [];
  const vip = ev.filter((e) => e.chat === "vip");
  const churned = vip.filter((e) => (e.type === "leave" || e.type === "removed") && +new Date(e.at) >= since).length;
  const newPaid = vip.filter((e) => e.type === "payment" && +new Date(e.at) >= since).length;
  const startActive = Math.max(0, paidNow.length - newPaid + churned);
  const churn = churnRate(startActive, newPaid, churned);
  const revenue30 = vip.filter((e) => (e.type === "payment" || e.type === "renewal") && +new Date(e.at) >= since).reduce((s, e) => s + Number(e.amount_inr ?? 0), 0);

  // Source funnel: clicks → joins → paid
  const linkSource = new Map((links.rows ?? []).map((l) => [l.id, l.source]));
  const sources = Array.from(new Set([...SOURCES, ...m.map((x) => x.source ?? "direct")]));
  const funnel = sources.map((s) => {
    const joined = m.filter((x) => (x.source ?? "direct") === s);
    return {
      source: s,
      clicks: (clicks.rows ?? []).filter((c) => linkSource.get(c.link_id) === s).length,
      joins: joined.length,
      paid: joined.filter((x) => x.status === "active" || x.status === "expiring").length,
    };
  }).filter((f) => f.clicks || f.joins);

  // 7-day activity
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * DAY).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const onDay = ev.filter((e) => new Date(e.at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === d);
    return { d, joins: onDay.filter((e) => e.type === "join").length, leaves: onDay.filter((e) => e.type === "leave" || e.type === "removed").length, pays: onDay.filter((e) => e.type === "payment" || e.type === "renewal").length };
  });
  const peak = Math.max(1, ...days.map((d) => Math.max(d.joins, d.leaves, d.pays)));

  const addPlan = async (e: React.FormEvent) => {
    e.preventDefault();
    const price = toNum(plan.price), months = Math.round(toNum(plan.months));
    if (!plan.name.trim() || !(price >= 0) || !(months >= 1 && months <= 12)) return setError("Name, price and 1–12 months");
    const { error } = await supabase.from("subscription_plans").insert({ name: plan.name.trim(), price_inr: price, months });
    if (error) return setError(error.message);
    setPlan({ name: "", price: "", months: "1" });
    plans.reload();
  };
  const addLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const slug = link.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!slug || !/^https:\/\//.test(link.target)) return setError("Slug and an https target are required");
    const { error } = await supabase.from("tracked_links").insert({ slug, source: link.source, campaign: link.campaign || null, target_url: link.target });
    if (error) return setError(error.message);
    setLink({ ...link, slug: "", campaign: "" });
    links.reload();
  };

  return (
    <div>
      <PageHead title="Telegram" />
      <ErrorNote error={error || members.error} />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Kpi label="VIP paid" value={paidNow.length} foot={`${m.filter((x) => x.status === "expiring").length} expiring`} />
        <Kpi label="MRR" value={money(monthly, "INR", 0)} tone="text-accent" />
        <Kpi label="Revenue · 30d" value={money(revenue30, "INR", 0)} />
        <Kpi label="Churn · 30d" value={pct(churn, 1)} tone={churn > 0.1 ? "text-down" : ""} foot={`${churned} left · ${newPaid} new`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Member sources">
          {funnel.length === 0 ? <Empty>No tracked members yet</Empty> : (
            <Table head={["Source", "Clicks", "Joins", "Paid", "Conv."]}>
              {funnel.map((f) => (
                <tr key={f.source}>
                  <td className="capitalize">{f.source.replace(/_/g, " ")}</td>
                  <td className="num">{f.clicks || "—"}</td>
                  <td className="num">{f.joins}</td>
                  <td className="num text-up">{f.paid}</td>
                  <td className="num">{f.joins ? pct(f.paid / f.joins, 1) : "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="Channel activity · 7 days">
          <div className="flex h-44 items-end gap-2">
            {days.map((d) => (
              <div key={d.d} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex h-36 w-full items-end justify-center gap-0.5">
                  <div className="w-2 rounded-t bg-up" style={{ height: `${(d.joins / peak) * 100}%` }} title={`${d.joins} joins`} />
                  <div className="w-2 rounded-t bg-accent" style={{ height: `${(d.pays / peak) * 100}%` }} title={`${d.pays} payments`} />
                  <div className="w-2 rounded-t bg-down" style={{ height: `${(d.leaves / peak) * 100}%` }} title={`${d.leaves} leaves`} />
                </div>
                <span className="num text-[10px] text-mute">{d.d.slice(8)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-4 text-xs text-mute">
            <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-up" />Joins</span>
            <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-accent" />Payments</span>
            <span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-down" />Leaves</span>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Plans">
          {planRows.length > 0 && (
            <div className="mb-4">
              <Bars items={planRows.map((p) => ({ label: `${p.name}`, value: paidNow.filter((x) => x.plan_id === p.id).length, display: `${paidNow.filter((x) => x.plan_id === p.id).length} · ${money(Number(p.price_inr), "INR", 0)}` }))} />
            </div>
          )}
          <form onSubmit={addPlan} className="grid grid-cols-[1fr_110px_80px_auto] items-end gap-2">
            <Field label="Plan"><input className="input" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} /></Field>
            <Field label="Price ₹"><input className="input num" inputMode="decimal" value={plan.price} onChange={(e) => setPlan({ ...plan, price: e.target.value })} /></Field>
            <Field label="Months"><input className="input num" inputMode="numeric" value={plan.months} onChange={(e) => setPlan({ ...plan, months: e.target.value })} /></Field>
            <button className="btn-ghost">Add</button>
          </form>
        </Card>
        <Card title="Tracked links">
          {(links.rows ?? []).length > 0 && (
            <div className="mb-4 space-y-1.5">
              {(links.rows ?? []).map((l) => (
                <div key={l.id} className="flex items-center justify-between rounded-xl bg-raised px-3 py-2 text-sm">
                  <span className="num truncate">/{l.slug}</span>
                  <span className="flex items-center gap-2"><Badge>{l.source.replace(/_/g, " ")}</Badge><span className="num text-mute">{(clicks.rows ?? []).filter((c) => c.link_id === l.id).length}</span></span>
                </div>
              ))}
            </div>
          )}
          <form onSubmit={addLink} className="grid gap-2 sm:grid-cols-2">
            <Field label="Slug"><input className="input num" placeholder="ig-bio" value={link.slug} onChange={(e) => setLink({ ...link, slug: e.target.value })} /></Field>
            <Field label="Source"><select className="input" value={link.source} onChange={(e) => setLink({ ...link, source: e.target.value })}>{SOURCES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select></Field>
            <Field label="Campaign"><input className="input" value={link.campaign} onChange={(e) => setLink({ ...link, campaign: e.target.value })} /></Field>
            <Field label="Target"><input className="input" placeholder="https://t.me/+…" value={link.target} onChange={(e) => setLink({ ...link, target: e.target.value })} /></Field>
            <div className="sm:col-span-2"><button className="btn-ghost">Add link</button></div>
          </form>
        </Card>
      </div>

      <Card title="Post engagement" className="mt-4">
        {(posts.rows ?? []).length === 0 ? <Empty>No posts</Empty> : (
          <Table head={["Sent", "Kind", "To", "Views", "Reactions", "Clicks", "Status"]}>
            {(posts.rows ?? []).map((p) => (
              <tr key={p.id}>
                <td className="num text-mute">{dateShort(p.sent_at ?? p.created_at)}</td>
                <td>{p.kind}</td>
                <td className="text-mute">{p.destination}</td>
                <td className="num">{p.views ?? "—"}</td>
                <td className="num">{p.reactions ?? "—"}</td>
                <td className="num">{p.clicks ?? "—"}</td>
                <td><Badge tone={p.status === "sent" ? "up" : p.status === "failed" ? "down" : "mute"}>{p.status}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Members" className="mt-4">
        {m.length === 0 ? <Empty>No members</Empty> : (
          <Table head={["Member", "Source", "Plan", "Paid until", "Joined", "Status"]}>
            {m.slice(0, 100).map((x) => (
              <tr key={x.id}>
                <td>{x.username ? `@${x.username}` : <span className="num text-mute">{x.telegram_user_id}</span>}</td>
                <td className="capitalize text-mute">{(x.source ?? "direct").replace(/_/g, " ")}</td>
                <td>{planRows.find((p) => p.id === x.plan_id)?.name ?? "—"}</td>
                <td className="num">{dateShort(x.paid_until)}</td>
                <td className="num text-mute">{dateShort(x.first_seen)}</td>
                <td><Badge tone={STATUS_TONE[x.status]}>{x.status}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
