"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase } from "@/lib/supabase";
import type { Integrations, Role } from "@/lib/types";
import NotificationBell from "@/components/Notifications";
import { Logo } from "@/components/Brand";
import { Icon } from "@/components/ui";
import { useApi } from "@/lib/useApi";
import { staffPost } from "@/lib/market";
import MfaGate from "@/components/MfaGate";

export type Settings = {
  mode: "PAPER" | "LIVE";
  kill_switch: boolean;
  aggressive_entry_allowed: boolean;
  counter_trend_allowed: boolean;
  advanced_models_allowed: boolean;
  equity_throttle: boolean;
  prop_buffer: boolean;
  auto_modes: Record<string, "Off" | "Paper" | "Confirm" | "Auto">;
  broadcast: { vip: boolean; free: boolean; instruments: Record<string, boolean>; events: Record<string, boolean> };
  news_block_minutes: number;
  news_medium_gold: boolean;
  quiet_from: string;
  quiet_to: string;
  integrations: Integrations | null;
};
type Me = {
  session: Session;
  role: Role;
  investorId: string | null;
  name: string;
  isStaff: boolean;
  settings: Settings | null;
  updateSettings: (patch: Partial<Settings>) => Promise<string | null>;
  /** Fresh TOTP verification before a sensitive action; returns an error message or null. */
  stepUp: (code: string) => Promise<string | null>;
};
const Ctx = createContext<Me | null>(null);
export function useMe(): Me {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMe outside Shell");
  return v;
}

type NavItem = { h?: string; href?: string; l?: string; tl?: string; i?: string; cnt?: string; pip?: string };

export const ICONS = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  cfd: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 21h8",
  delta: "M12 4l9 16H3z",
  coinswitch: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9 9.5a3.5 3.5 0 1 1 0 5M15 9.5a3.5 3.5 0 1 0 0 5",
  fyers: "M4 20V12M9 20V8M14 20v-5M19 20V5M3 20h18",
  league: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM5 4h2M17 4h2",
  backtest: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2",
  playbook: "M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM8 7h6M8 11h6",
  edge: "M3 17l6-6 4 4 8-8M14 7h7v7",
  pnl: "M4 20V10M10 20V4M16 20v-7M2 20h20",
  risk: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  accounts: "M3 7h18v13H3zM3 7l3-4h12l3 4M16 13h2",
  investors: "M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8zM2 21a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7M22 21a7 7 0 0 0-4-6.3",
  payouts: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  integrations: "M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  send: "M22 3L11 13M22 3l-7 18-4-8-8-4z",
  settings: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM21 21l-4-4",
  power: "M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0",
} as const;

const OWNER_NAV: NavItem[] = [
  { href: "/", l: "Dashboard", tl: "Home", i: ICONS.home },
  { h: "Arenas" },
  { href: "/arena/cfd", l: "CFD Arena", tl: "CFD", i: ICONS.cfd, pip: "--cfd", cnt: "cfd" },
  { href: "/arena/delta", l: "Delta Arena", tl: "Delta", i: ICONS.delta, pip: "--delta" },
  { href: "/arena/coinswitch", l: "CoinSwitch Arena", i: ICONS.coinswitch, pip: "--cs" },
  { href: "/arena/fyers", l: "Fyers Arena", i: ICONS.fyers, pip: "--fyers" },
  { h: "Strategy" },
  { href: "/league", l: "Strategy League", tl: "League", i: ICONS.league },
  { href: "/backtest", l: "Backtest Suite", i: ICONS.backtest },
  { href: "/playbook", l: "Playbook", i: ICONS.playbook },
  { h: "Analytics" },
  { href: "/edge", l: "Edge Analytics", i: ICONS.edge },
  { href: "/analytics", l: "P&L Analytics", i: ICONS.pnl },
  { href: "/risk", l: "Risk", i: ICONS.risk },
  { h: "Capital" },
  { href: "/accounts", l: "Accounts", tl: "Accounts", i: ICONS.accounts, cnt: "accounts" },
  { href: "/investors", l: "Investors", i: ICONS.investors, cnt: "investors" },
  { href: "/admin", l: "Payouts & audit", i: ICONS.payouts, cnt: "payouts" },
  { h: "System" },
  { href: "/integrations", l: "Integrations", i: ICONS.integrations },
  { href: "/alerts", l: "Telegram alerts", i: ICONS.send, cnt: "alerts" },
  { href: "/notifications", l: "Notifications", i: ICONS.bell },
  { href: "/settings", l: "Settings", i: ICONS.settings },
  { href: "/me", l: "Preview as investor", i: ICONS.eye },
];

const INVESTOR_NAV: NavItem[] = [
  { h: "Your money" },
  { href: "/me", l: "Overview", tl: "Overview", i: ICONS.home },
  { href: "/me/accounts", l: "My accounts", tl: "Accounts", i: ICONS.accounts },
  { href: "/me/insights", l: "Insights & AI outlook", tl: "Insights", i: ICONS.pnl },
  { href: "/me/trades", l: "Trade log", tl: "Trades", i: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11" },
];

/** Breadcrumb group and title for a path. */
const GROUPS: Record<string, string> = {};
{ let g = ""; for (const n of OWNER_NAV) { if (n.h) g = n.h; else if (n.href) GROUPS[n.href] = g; } }
const TITLES: Record<string, string> = Object.fromEntries(
  [...OWNER_NAV, ...INVESTOR_NAV].filter((n) => n.href).map((n) => [n.href!, n.l!]),
);
TITLES["/me"] = "Overview";

const PUBLIC = [/^\/login/];

function setCookie(k: string, v: string) {
  document.cookie = `${k}=${v}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
}

function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => setDark(!document.documentElement.classList.contains("light")), []);
  const flip = () => {
    const c = document.documentElement.classList;
    c.remove("dark", "light");
    c.add(dark ? "light" : "dark");
    setCookie("mode", dark ? "light" : "dark");
    setDark(!dark);
  };
  return (
    <button className="ibtn" onClick={flip} aria-label={`Switch to ${dark ? "light" : "dark"} mode`} style={{ marginLeft: "auto" }}>
      <Icon d={dark ? "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" : "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"} />
    </button>
  );
}

/** Trading session by UTC hour (FX conventions); weekends are crypto-only. */
export function sessionName(now = new Date()) {
  const h = now.getUTCHours() + now.getUTCMinutes() / 60, d = now.getUTCDay();
  if (d === 6 || (d === 0 && h < 22) || (d === 5 && h >= 21)) return "Weekend";
  if (h < 7) return "Asia"; if (h < 12) return "London"; if (h < 16) return "London–NY"; if (h < 21) return "New York"; return "Asia";
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(t); }, []);
  if (!now) return null;
  return (
    <span className="tbtn hide-m" style={{ cursor: "default" }}>
      <span className="mono" style={{ color: "var(--text)" }}>{now.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST</span>
      <span>{sessionName(now)}</span>
    </span>
  );
}

type FeedRow = { id: string; label: string; status: "live" | "closed" | "stale" | "down"; feed: string | null; quoteAgeSec: number | null };

/** One button for every feed: green live, red down, grey closed. Opens the full list. */
function FeedStatus() {
  const s = useApi<{ markets: FeedRow[] }>("/api/market/status", 30_000);
  const [open, setOpen] = useState(false);
  const ms = s.data?.markets ?? [];
  const live = ms.filter((m) => m.status === "live").length, bad = ms.filter((m) => m.status === "down" || m.status === "stale").length;
  const closed = ms.length - live - bad;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".pop, .feed-btn")) setOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  return (
    <>
      <button className="tbtn feed-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`led ${s.error || bad ? "down" : live ? "live" : ""}`} />
        {s.error ? "Feeds unreachable" : ms.length ? <>{live} live{bad ? ` · ${bad} down` : ""}<span className="hide-m">{closed ? ` · ${closed} closed` : ""}</span></> : "Feeds"}
      </button>
      {open && (
        <div className="pop" role="dialog" aria-label="Feeds">
          <div className="between" style={{ marginBottom: 6 }}><b>Feeds</b><span className="faint" style={{ fontSize: 12 }}>quote age</span></div>
          {ms.map((m) => (
            <div key={m.id} className="fr">
              <span className={`led ${m.status === "live" ? "live" : m.status === "closed" ? "" : m.status === "stale" ? "stale" : "down"}`} />
              <span>{m.label} <span className="faint">{m.status === "live" ? (m.feed ? `· ${m.feed}` : "") : `· ${m.status}`}</span></span>
              <span className="mono faint" style={{ fontSize: 12 }}>{m.quoteAgeSec === null ? "—" : `${m.quoteAgeSec}s`}</span>
            </div>
          ))}
          {s.error && <p className="down" style={{ fontSize: 12.5 }}>{s.error}</p>}
          <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>Green live · red down · grey market closed</p>
        </div>
      )}
    </>
  );
}

const PALETTE_EXTRA: { href: string; l: string; g: string }[] = [
  { href: "/arena/cfd?tab=challenge", l: "Prop challenges", g: "CFD Arena" },
  { href: "/arena/cfd?tab=journal", l: "Journal", g: "CFD Arena" },
  { href: "/arena/cfd?tab=bias", l: "Daily bias", g: "CFD Arena" },
  { href: "/arena/cfd?tab=discipline", l: "Discipline & mood", g: "CFD Arena" },
  { href: "/arena/delta?tab=execution", l: "Delta execution", g: "Delta Arena" },
];

function Palette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const all = [...OWNER_NAV.filter((n) => n.href).map((n) => ({ href: n.href!, l: n.l!, g: GROUPS[n.href!] || "Page" })), ...PALETTE_EXTRA];
  const list = all.filter((x) => `${x.l} ${x.g}`.toLowerCase().includes(q.toLowerCase())).slice(0, 10);
  const go = (href: string) => { onClose(); router.push(href); };
  return (
    <div className="palette-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search">
        <input autoFocus placeholder="Go to a page…" value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((sel + 1) % Math.max(1, list.length)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((sel - 1 + list.length) % Math.max(1, list.length)); }
            if (e.key === "Enter" && list[sel]) go(list[sel].href);
            if (e.key === "Escape") onClose();
          }} />
        <div className="res">
          {list.length === 0 ? <div className="empty" style={{ border: 0 }}>Nothing matches</div> : list.map((x, i) => (
            <a key={x.href} href={x.href} className={i === sel ? "on" : ""} onClick={(e) => { e.preventDefault(); go(x.href); }}>{x.l}<small>{x.g}</small></a>
          ))}
        </div>
      </div>
    </div>
  );
}

type Turn = { role: "user" | "assistant"; text: string };

/** The global agent: one conversation across pages, sent with the page the user is on. */
function Agent({ open, onClose, page }: { open: boolean; onClose: () => void; page: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    const next: Turn[] = [...turns, { role: "user", text }];
    setTurns(next); setQ(""); setBusy(true);
    try {
      const r = await staffPost<{ answer: string }>("/api/ai", { task: "chat", desk: "gold", context: { page, scope: "global agent: all accounts, arenas and strategies" }, turns: next });
      setTurns([...next, { role: "assistant", text: r.answer }]);
    } catch (err) {
      setTurns([...next, { role: "assistant", text: `I couldn't answer: ${(err as Error).message}` }]);
    } finally { setBusy(false); }
  };
  return (
    <aside className={`drawer${open ? " open" : ""}`} aria-label="Agent" aria-hidden={!open}>
      <header>
        <span className="orb" style={{ width: 26, height: 26, flexBasis: 26 }} />
        <div><b>Agent</b><div className="faint" style={{ fontSize: 12 }}>Asks about any account, arena or strategy</div></div>
        <button className="ibtn" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close agent"><Icon d="M6 6l12 12M18 6L6 18" /></button>
      </header>
      <div className="msgs">
        {turns.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Ask about open trades, prop account room, a strategy's results or what the engine sees on a market.</p>}
        {turns.map((t, i) => <div key={i} className={`msg${t.role === "user" ? " me" : ""}`}>{t.text}</div>)}
        {busy && <div className="msg faint">Thinking…</div>}
      </div>
      <form onSubmit={ask}>
        <div className="inp txt"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask the agent" aria-label="Question" /></div>
        <button className="btn pri" disabled={busy || !q.trim()}>Send</button>
      </form>
    </aside>
  );
}

function Splash({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="col" style={{ alignItems: "center", gap: 14, textAlign: "center" }}>
        <Logo className="h-12 w-12" />
        <p className="muted" style={{ fontSize: 13 }}>{text}</p>
        {action}
      </div>
    </div>
  );
}

async function resolveRole(session: Session): Promise<{ role: Role | null; investorId: string | null; name: string }> {
  const uid = session.user.id;
  const m = await supabase.from("members").select("role, display_name").eq("user_id", uid).maybeSingle();
  if (m.error) throw new Error(m.error.message);
  let role = (m.data?.role as Role | undefined) ?? null;
  let name = m.data?.display_name ?? "";
  if (!role) {
    const link = await supabase.rpc("link_investor_login");
    if (!link.error && link.data) role = "investor";
  }
  if (!role) {
    const claim = await supabase.rpc("claim_owner", { p_display_name: session.user.email?.split("@")[0] ?? "" });
    if (!claim.error && claim.data) role = claim.data as Role;
  }
  let investorId: string | null = null;
  if (role === "investor") {
    const inv = await supabase.from("investors").select("id, name").eq("user_id", uid).maybeSingle();
    investorId = inv.data?.id ?? null;
    name = name || inv.data?.name || "";
  }
  return { role, investorId, name: name || session.user.email?.split("@")[0] || "" };
}

function initials(name: string) {
  return name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "A";
}

function Sidebar({ items, active, sub, counts, name, onNavigate }: { items: NavItem[]; active: (h: string) => boolean; sub: string; counts: Record<string, string>; name: string; onNavigate?: () => void }) {
  return (
    <aside className="side">
      <div className="brand"><Logo /><div><b>A+ Tradeplay</b><small>{sub}</small></div></div>
      <nav className="navs" aria-label="Main">
        {items.map((n, i) =>
          n.h ? <div key={i} className="nav-h">{n.h}</div> : (
            <Link key={n.href} href={n.href!} onClick={onNavigate} className={`nav-i${active(n.href!) ? " on" : ""}`} aria-current={active(n.href!) ? "page" : undefined}>
              <Icon d={n.i!} />
              <span>{n.l}</span>
              {n.cnt && counts[n.cnt] ? <span className="cnt">{counts[n.cnt]}</span> : n.pip ? <i className="pip" style={{ background: `var(${n.pip})` }} /> : null}
            </Link>
          ),
        )}
      </nav>
      <div className="side-foot">
        <div className="ava">{initials(name)}</div>
        <div style={{ minWidth: 0 }}><b style={{ fontWeight: 500, fontSize: 13 }}>{name}</b><button className="faint" style={{ display: "block", fontSize: 11.5, background: "none", border: 0, padding: 0 }} onClick={() => supabase.auth.signOut()}>Sign out</button></div>
        <ThemeToggle />
      </div>
    </aside>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [base, setBase] = useState<Omit<Me, "settings" | "updateSettings" | "isStaff" | "stepUp"> | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aal2, setAal2] = useState<boolean | null>(null);
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [agent, setAgent] = useState(false);
  const [confirmLive, setConfirmLive] = useState(false);
  const [stepCode, setStepCode] = useState("");
  const [stepErr, setStepErr] = useState<string | null>(null);
  const isPublic = PUBLIC.some((r) => r.test(pathname));

  useEffect(() => {
    if (!configured) return setSession(null);
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const checkAal = useCallback(async () => {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    setAal2(data?.currentLevel === "aal2");
  }, []);

  useEffect(() => {
    if (!session) { setBase(null); return; }
    let live = true;
    resolveRole(session)
      .then((r) => {
        if (!live) return;
        if (!r.role) return setDenied(true);
        setBase({ session, role: r.role, investorId: r.investorId, name: r.name });
      })
      .catch((e: Error) => live && setError(e.message));
    checkAal();
    return () => { live = false; };
  }, [session, checkAal]);

  const isStaff = base?.role === "owner" || base?.role === "admin";

  const loadStaff = useCallback(async () => {
    const today = new Date(Date.now() - 18 * 3_600_000).toISOString();
    const [s, a, i, p, al, sig] = await Promise.all([
      supabase.from("app_settings").select("*").maybeSingle(),
      supabase.from("trading_accounts").select("id", { count: "exact", head: true }).eq("active", true),
      supabase.from("investors").select("id", { count: "exact", head: true }),
      supabase.from("payouts").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("telegram_alerts").select("id", { count: "exact", head: true }).gte("at", today),
      supabase.from("signals").select("instrument").eq("state", "ARMED").gte("created_at", today),
    ]);
    if (s.data) setSettings(s.data as Settings);
    const armed = new Set((sig.data ?? []).map((x) => x.instrument as string));
    setCounts({
      accounts: a.count ? String(a.count) : "",
      investors: i.count ? String(i.count) : "",
      payouts: p.count ? String(p.count) : "",
      alerts: al.count ? String(al.count) : "",
      cfd: armed.size ? `${armed.size} armed` : "",
    });
  }, []);

  useEffect(() => {
    if (isStaff && aal2) loadStaff();
  }, [isStaff, aal2, loadStaff, pathname]);

  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); }
      if (e.key === "Escape") setAgent(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  useEffect(() => {
    if (!base) return;
    if (!isStaff && !pathname.startsWith("/me")) router.replace("/me");
  }, [base, isStaff, pathname, router]);

  /** Step-up: a fresh TOTP verification right before a sensitive change. */
  const stepUp = useCallback(async (code: string) => {
    const f = await supabase.auth.mfa.listFactors();
    const totp = f.data?.totp.find((x) => x.status === "verified");
    if (!totp) return "No verified authenticator";
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code });
    return error ? error.message : null;
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const { data, error } = await supabase.from("app_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1).select("*").single();
    if (error) return error.message;
    setSettings(data as Settings);
    loadStaff();
    return null;
  }, [loadStaff]);

  if (isPublic) return <>{children}</>;
  if (!configured) return <Splash text="Supabase environment variables are missing." />;
  if (session === undefined) return <Splash text="Loading…" />;
  if (session === null) {
    if (typeof window !== "undefined") window.location.replace("/login");
    return <Splash text="Redirecting…" />;
  }
  const signOut = <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>;
  if (error) return <Splash text={error} action={signOut} />;
  if (denied) return <Splash text="This login has no access yet." action={signOut} />;
  if (!base || aal2 === null) return <Splash text="Loading…" />;
  if (isStaff && !aal2) return <MfaGate onDone={checkAal} />;

  const investorView = pathname.startsWith("/me");
  const items = investorView ? INVESTOR_NAV : OWNER_NAV;
  const sideItems = investorView && isStaff ? [...INVESTOR_NAV, { h: "Owner" }, { href: "/", l: "Back to owner console", i: "M15 18l-6-6 6-6" }] : items;
  const active = (href: string) => (href === "/" || href === "/me" ? pathname === href : pathname.startsWith(href));
  const key = TITLES[pathname] ? pathname : pathname.startsWith("/arena/") ? pathname.split("/").slice(0, 3).join("/") : "/" + pathname.split("/")[1];
  const title = investorView && pathname === "/me" ? `Hi ${base.name.split(/[\s._-]/)[0]}` : TITLES[key] ?? "A+ Tradeplay";
  const group = investorView ? "" : GROUPS[key] ?? "";
  const tabs = items.filter((n) => n.tl);
  const me: Me = { ...base, isStaff, settings, updateSettings, stepUp };
  const live = settings?.mode === "LIVE";

  return (
    <Ctx.Provider value={me}>
      <div className="shell">
        <Sidebar items={sideItems} active={active} sub={investorView ? "Investor app" : "Owner console"} counts={counts} name={base.name} />
        {menu && (
          <div className="sheet">
            <div className="scrim" onClick={() => setMenu(false)} />
            <Sidebar items={sideItems} active={active} sub={investorView ? "Investor app" : "Owner console"} counts={counts} name={base.name} onNavigate={() => setMenu(false)} />
          </div>
        )}
        <main className="main">
          <header className="top">
            <button className="ibtn menu-btn" aria-label="Menu" onClick={() => setMenu(true)}><Icon d="M4 6h16M4 12h16M4 18h16" /></button>
            <div className="crumb">{group && <><span className="hide-m">{group}</span><span className="hide-m">/</span></>}<b>{title}</b></div>
            <div className="sp" />
            {isStaff && !investorView && (
              <>
                <button className="tbtn hide-m" onClick={() => setPalette(true)}><Icon d={ICONS.search} />Search<kbd>⌘K</kbd></button>
                <button className="tbtn" onClick={() => setAgent(true)}><span className="orb" /><span className="hide-m">Ask agent</span></button>
                <FeedStatus />
                <Clock />
              </>
            )}
            {isStaff && !investorView && settings && (
              <button className={`live-pill ${live ? "live" : "paper"}`} onClick={() => (live ? updateSettings({ mode: "PAPER" }) : setConfirmLive(true))} title="Execution mode">
                <span className="dot" />{settings.mode}
              </button>
            )}
            {isStaff && !investorView && <NotificationBell />}
            {isStaff && !investorView && settings && (
              <button className={`tbtn kill hide-m${settings.kill_switch ? " on" : ""}`} onClick={() => updateSettings({ kill_switch: !settings.kill_switch })} aria-pressed={settings.kill_switch} aria-label="Global kill switch">
                <Icon d={ICONS.power} />{settings.kill_switch ? "Kill switch on" : "Kill switch"}
              </button>
            )}
          </header>
          <div className="content">
            {isStaff && settings?.kill_switch && !investorView && (
              <div className="banner down"><span className="dot" /><b>Kill switch is on.</b> No orders are sent to any account.</div>
            )}
            {children}
          </div>
        </main>
        <nav className="tabbar" aria-label="Main">
          {tabs.map((n) => (
            <Link key={n.href} href={n.href!} className={active(n.href!) ? "on" : ""} aria-current={active(n.href!) ? "page" : undefined}>
              <Icon d={n.i!} />{n.tl}
            </Link>
          ))}
        </nav>
      </div>

      {palette && <Palette onClose={() => setPalette(false)} />}
      {isStaff && !investorView && <Agent open={agent} onClose={() => setAgent(false)} page={title} />}
      {confirmLive && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Switch to LIVE">
          <div className="card">
            <div className="ch"><h3>Switch to LIVE execution?</h3></div>
            <p className="muted" style={{ fontSize: 13 }}>Orders from the desks and autopilot are treated as real: paper fills stop and every ticket needs execution on the account.</p>
            <div className="fld" style={{ marginTop: 14 }}>
              <label htmlFor="step">Authenticator code</label>
              <div className="inp"><input id="step" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={stepCode} onChange={(e) => setStepCode(e.target.value.replace(/\D/g, ""))} autoFocus /></div>
            </div>
            {stepErr && <p className="down" style={{ fontSize: 12.5, marginTop: 8 }}>{stepErr}</p>}
            <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => { setConfirmLive(false); setStepCode(""); setStepErr(null); }}>Cancel</button>
              <button className="btn sell" disabled={stepCode.length !== 6} onClick={async () => {
                const e = await stepUp(stepCode);
                if (e) return setStepErr(e);
                const u = await updateSettings({ mode: "LIVE" });
                if (u) return setStepErr(u);
                setConfirmLive(false); setStepCode(""); setStepErr(null);
              }}>Go LIVE</button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
