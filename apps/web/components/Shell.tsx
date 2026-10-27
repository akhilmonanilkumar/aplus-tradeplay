"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase } from "@/lib/supabase";
import type { Integrations, Role } from "@/lib/types";
import { Logo } from "@/components/Brand";
import { Icon } from "@/components/ui";
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

type NavItem = { h?: string; href?: string; l?: string; tl?: string; i?: string; cnt?: string };

const OWNER_NAV: NavItem[] = [
  { h: "Overview" },
  { href: "/", l: "Dashboard", tl: "Home", i: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { h: "Desks" },
  { href: "/desk/gold", l: "Gold desk", tl: "Gold", i: "M4 15l3-8h10l3 8zM2 19h20M9 7l1-3h4l1 3", cnt: "gold" },
  { href: "/desk/btc", l: "BTC desk", tl: "BTC", i: "M9 4v16M13 4v3M13 17v3M7 7h7a3 3 0 0 1 0 6H7M7 13h8a3 3 0 0 1 0 6H7", cnt: "btc" },
  { href: "/desk/fx", l: "Forex desk", tl: "FX", i: "M4 7h13l-3-3M20 17H7l3 3" },
  { href: "/desk/indices", l: "Index desk", i: "M4 20V12M9 20V8M14 20v-5M19 20V5M3 20h18" },
  { href: "/lab/gold", l: "Gold lab", i: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.5 14h9" },
  { href: "/lab/btc", l: "BTC lab", i: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.5 14h9" },
  { href: "/lab/fx", l: "Forex lab", i: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.5 14h9" },
  { href: "/lab/indices", l: "Index lab", i: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7.5 14h9" },
  { href: "/playbook", l: "Playbook", i: "M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM8 7h6M8 11h6M18 3v18" },
  { href: "/autopilot", l: "Autopilot", i: "M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", cnt: "autopilot" },
  { href: "/bot", l: "Bot log", i: "M4 5h16M4 10h16M4 15h10M4 20h7M17 14l2 2 3-4" },
  { h: "Accounts" },
  { href: "/accounts", l: "Accounts", tl: "Accounts", i: "M3 7h18v13H3zM3 7l3-4h12l3 4M16 13h2", cnt: "accounts" },
  { href: "/investors", l: "Investors", i: "M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8zM2 21a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7M22 21a7 7 0 0 0-4-6.3", cnt: "investors" },
  { href: "/analytics", l: "P&L analytics", tl: "P&L", i: "M4 20V10M10 20V4M16 20v-7M2 20h20" },
  { href: "/risk", l: "Risk manager", i: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" },
  { href: "/prop", l: "Funded challenges", i: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 21h8" },
  { h: "Review" },
  { href: "/journal", l: "Journal", i: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11" },
  { href: "/bias", l: "Daily bias", i: "M6 3h9l4 4v14H6zM9 12h7M9 16h5M9 8h3" },
  { href: "/discipline", l: "Discipline & mood", i: "M3 12h4l2-5 4 10 2-5h6" },
  { h: "System" },
  { href: "/alerts", l: "Telegram alerts", i: "M22 3L11 13M22 3l-7 18-4-8-8-4z", cnt: "alerts" },
  { href: "/admin", l: "Payouts & audit", i: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", cnt: "payouts" },
  { href: "/settings", l: "Settings", i: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4" },
  { h: "Investor app" },
  { href: "/me", l: "Preview as investor", i: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z" },
];

const INVESTOR_NAV: NavItem[] = [
  { h: "Your money" },
  { href: "/me", l: "Overview", tl: "Overview", i: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { href: "/me/accounts", l: "My accounts", tl: "Accounts", i: "M3 7h18v13H3zM3 7l3-4h12l3 4M16 13h2" },
  { href: "/me/insights", l: "Insights & AI outlook", tl: "Insights", i: "M4 20V10M10 20V4M16 20v-7M2 20h20" },
  { href: "/me/trades", l: "Trade log", tl: "Trades", i: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11" },
];

const TITLES: Record<string, string> = Object.fromEntries(
  [...OWNER_NAV, ...INVESTOR_NAV].filter((n) => n.href).map((n) => [n.href!, n.l!]),
);
TITLES["/me"] = "Overview";

const PUBLIC = [/^\/login/];
const THEMES = ["gold", "ocean", "ember", "violet"] as const;
type Accent = (typeof THEMES)[number];

function setCookie(k: string, v: string) {
  document.cookie = `${k}=${v}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
}

function useLook() {
  const [dark, setDark] = useState(true);
  const [accent, setAccent] = useState<Accent>("gold");
  useEffect(() => {
    const c = document.documentElement.classList;
    setDark(!c.contains("light"));
    setAccent((THEMES.find((t) => c.contains(`t-${t}`)) ?? "gold") as Accent);
  }, []);
  const apply = useCallback((d: boolean, a: Accent) => {
    const c = document.documentElement.classList;
    c.remove("dark", "light", ...THEMES.map((t) => `t-${t}`));
    c.add(d ? "dark" : "light", `t-${a}`);
    setCookie("mode", d ? "dark" : "light");
    setCookie("accent", a);
    setDark(d);
    setAccent(a);
  }, []);
  return { dark, accent, setDark: (d: boolean) => apply(d, accent), setAccent: (a: Accent) => apply(dark, a) };
}

function Look() {
  const { dark, accent, setDark, setAccent } = useLook();
  return (
    <>
      <div className="tsw hide-m" role="group" aria-label="Colour theme">
        {THEMES.map((t) => <button key={t} className={`sw sw-${t}${t === accent ? " on" : ""}`} aria-label={`Use ${t} theme`} onClick={() => setAccent(t)} />)}
      </div>
      <button className="mode" onClick={() => setDark(!dark)} aria-label={`Switch to ${dark ? "light" : "dark"} mode`}>
        <Icon d={dark ? "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z" : "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"} className="h-3.5 w-3.5" />
        <span className="hide-m">{dark ? "Light" : "Dark"} mode</span>
      </button>
    </>
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

function Sidebar({ items, active, sub, counts, onNavigate }: { items: NavItem[]; active: (h: string) => boolean; sub: string; counts: Record<string, string>; onNavigate?: () => void }) {
  return (
    <aside className="side">
      <div className="brand"><Logo /><div><b>A+ Tradeplay</b><small>{sub}</small></div></div>
      {items.map((n, i) =>
        n.h ? <div key={i} className="nav-h">{n.h}</div> : (
          <Link key={n.href} href={n.href!} onClick={onNavigate} className={`nav-i${active(n.href!) ? " on" : ""}`} aria-current={active(n.href!) ? "page" : undefined}>
            <Icon d={n.i!} />
            <span>{n.l}</span>
            {n.cnt && counts[n.cnt] ? <span className="cnt">{counts[n.cnt]}</span> : null}
          </Link>
        ),
      )}
      <div style={{ flex: 1 }} />
      <button className="nav-i" style={{ background: "none", border: 0 }} onClick={() => supabase.auth.signOut()}>
        <Icon d="M15 4h4v16h-4M10 17l5-5-5-5M15 12H3" /><span>Sign out</span>
      </button>
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
    const [s, a, i, p, al, ap, sig] = await Promise.all([
      supabase.from("app_settings").select("*").maybeSingle(),
      supabase.from("trading_accounts").select("id", { count: "exact", head: true }).eq("active", true),
      supabase.from("investors").select("id", { count: "exact", head: true }),
      supabase.from("payouts").select("id", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("telegram_alerts").select("id", { count: "exact", head: true }).gte("at", today),
      supabase.from("autopilot_config").select("mode").neq("mode", "off"),
      supabase.from("signals").select("instrument").eq("state", "ARMED").gte("created_at", today),
    ]);
    if (s.data) setSettings(s.data as Settings);
    const armed = new Set((sig.data ?? []).map((x) => x.instrument as string));
    setCounts({
      accounts: a.count ? String(a.count) : "",
      investors: i.count ? String(i.count) : "",
      payouts: p.count ? String(p.count) : "",
      alerts: al.count ? String(al.count) : "",
      autopilot: ap.data?.length ? `${ap.data.length} on` : "",
      gold: armed.has("XAUUSD") || armed.has("XAUUSDT.P") ? "GO" : "",
      btc: armed.has("BTCUSDT.P") || armed.has("BTCUSD") || armed.has("BTCUSD.SPOT") ? "GO" : "",
    });
  }, []);

  useEffect(() => {
    if (isStaff && aal2) loadStaff();
  }, [isStaff, aal2, loadStaff, pathname]);

  useEffect(() => setMenu(false), [pathname]);

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
  const title = investorView && pathname === "/me" ? `Hi ${base.name.split(/[\s._-]/)[0]}` : TITLES[pathname] ?? TITLES["/" + pathname.split("/")[1]] ?? "A+ Tradeplay";
  const tabs = items.filter((n) => n.tl);
  const me: Me = { ...base, isStaff, settings, updateSettings, stepUp };
  const live = settings?.mode === "LIVE";

  return (
    <Ctx.Provider value={me}>
      <div className="shell">
        <Sidebar items={sideItems} active={active} sub={investorView ? "Investor app" : "Owner console"} counts={counts} />
        {menu && (
          <div className="sheet">
            <div className="scrim" onClick={() => setMenu(false)} />
            <Sidebar items={sideItems} active={active} sub={investorView ? "Investor app" : "Owner console"} counts={counts} onNavigate={() => setMenu(false)} />
          </div>
        )}
        <main className="main">
          <header className="top">
            <button className="ibtn menu-btn" aria-label="Menu" onClick={() => setMenu(true)}><Icon d="M4 6h16M4 12h16M4 18h16" /></button>
            <div><h1>{title}</h1></div>
            <div className="sp" />
            {isStaff && !investorView && settings && (
              <button className={`live-pill ${live ? "live" : "paper"}`} onClick={() => (live ? updateSettings({ mode: "PAPER" }) : setConfirmLive(true))} title="Execution mode">
                <span className="dot" />{settings.mode}
              </button>
            )}
            <Look />
            {isStaff && !investorView && settings && (
              <button className={`btn danger sm hide-m${settings.kill_switch ? " pri" : ""}`} onClick={() => updateSettings({ kill_switch: !settings.kill_switch })} aria-pressed={settings.kill_switch} aria-label="Global kill switch">
                <Icon d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" className="h-3.5 w-3.5" />{settings.kill_switch ? "Kill switch ON" : "Kill switch"}
              </button>
            )}
            <div className="ava" aria-label={`Signed in as ${base.name}`} title={base.session.user.email ?? ""}>{initials(base.name)}</div>
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
