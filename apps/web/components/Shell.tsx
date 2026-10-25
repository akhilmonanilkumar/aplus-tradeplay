"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase } from "@/lib/supabase";
import type { Role } from "@/lib/types";
import { Logo, Mark } from "@/components/Brand";
import { Icon } from "@/components/ui";
import MfaGate from "@/components/MfaGate";

type Me = { session: Session; role: Role; investorId: string | null; name: string };
const Ctx = createContext<Me | null>(null);
export function useMe(): Me {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMe outside Shell");
  return v;
}

const I = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  copilot: "M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z",
  calc: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 7h8M8 12h2M14 12h2M8 16h2M14 16h2",
  copy: "M8 8h11v11H8zM5 16V5h11",
  accounts: "M3 7h18v12H3zM3 11h18M7 15h3",
  investors: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  payouts: "M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  telegram: "M21 4L3 11l6 2 2 6 3-4 5 4z",
  journal: "M4 6h16M4 12h16M4 18h10",
  analytics: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  out: "M15 4h4v16h-4M10 17l5-5-5-5M15 12H3",
  menu: "M4 6h16M4 12h16M4 18h16",
};

const STAFF_NAV = [
  { href: "/", label: "Command", icon: I.home },
  { href: "/copilot", label: "Copilot", icon: I.copilot },
  { href: "/calculator", label: "Size", icon: I.calc },
  { href: "/copy", label: "Copy engine", icon: I.copy },
  { href: "/accounts", label: "Accounts", icon: I.accounts },
  { href: "/investors", label: "Investors", icon: I.investors },
  { href: "/payouts", label: "Payouts", icon: I.payouts },
  { href: "/telegram", label: "Telegram", icon: I.telegram },
  { href: "/trades", label: "Journal", icon: I.journal },
  { href: "/analytics", label: "Analytics", icon: I.analytics },
  { href: "/settings", label: "Settings", icon: I.settings },
];
const STAFF_MOBILE = ["/", "/copilot", "/calculator", "/copy"];

const INVESTOR_NAV = [
  { href: "/me", label: "Overview", icon: I.home },
  { href: "/me/accounts", label: "Accounts", icon: I.accounts },
  { href: "/me/trades", label: "Trades", icon: I.journal },
];

const PUBLIC = [/^\/login/];

export type Theme = "dark" | "light" | "system";
function ThemeToggle({ rail = false }: { rail?: boolean }) {
  const [theme, set] = useState<Theme>("dark");
  useEffect(() => {
    const t = document.documentElement.dataset.theme as Theme | undefined;
    if (t) set(t);
  }, []);
  const next: Theme = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
  const apply = () => {
    document.documentElement.dataset.theme = next;
    document.cookie = `theme=${next}; path=/; max-age=31536000; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
    set(next);
  };
  const icon =
    theme === "dark" ? "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"
    : theme === "light" ? "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"
    : "M4 5h16v11H4zM8 20h8M12 16v4";
  return (
    <button onClick={apply} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`} className={rail ? "grid h-11 w-11 place-items-center rounded-[14px] text-[#9AA0AA] hover:bg-white/10 hover:text-white" : "grid h-10 w-10 place-items-center rounded-full bg-panel text-mute hover:text-ink"}>
      <Icon d={icon} className={rail ? "h-5 w-5" : "h-4 w-4"} />
    </button>
  );
}

function Splash({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <Logo className="h-12 w-12" />
        <p className="text-sm text-mute">{text}</p>
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

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aal2, setAal2] = useState<boolean | null>(null);
  const [more, setMore] = useState(false);
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
    if (!session) { setMe(null); return; }
    let live = true;
    resolveRole(session)
      .then((r) => {
        if (!live) return;
        if (!r.role) return setDenied(true);
        setMe({ session, role: r.role, investorId: r.investorId, name: r.name });
      })
      .catch((e: Error) => live && setError(e.message));
    checkAal();
    return () => { live = false; };
  }, [session, checkAal]);

  useEffect(() => setMore(false), [pathname]);

  const isInvestor = me?.role === "investor";
  useEffect(() => {
    if (!me) return;
    if (isInvestor && !pathname.startsWith("/me")) router.replace("/me");
    if (!isInvestor && pathname.startsWith("/me")) router.replace("/");
  }, [me, isInvestor, pathname, router]);

  if (isPublic) return <>{children}</>;
  if (!configured) return <Splash text="Supabase environment variables are missing." />;
  if (session === undefined) return <Splash text="Loading…" />;
  if (session === null) {
    if (typeof window !== "undefined") window.location.replace("/login");
    return <Splash text="Redirecting…" />;
  }
  const signOut = <button className="btn-ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>;
  if (error) return <Splash text={error} action={signOut} />;
  if (denied) return <Splash text="This login has no access yet." action={signOut} />;
  if (!me || aal2 === null) return <Splash text="Loading…" />;
  if (!isInvestor && !aal2) return <MfaGate onDone={checkAal} />;

  const nav = isInvestor ? INVESTOR_NAV : STAFF_NAV;
  const mobile = isInvestor ? nav : nav.filter((n) => STAFF_MOBILE.includes(n.href));
  const overflow = isInvestor ? [] : nav.filter((n) => !STAFF_MOBILE.includes(n.href));
  const active = (href: string) => (href === "/" || href === "/me" ? pathname === href : pathname.startsWith(href));
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" });

  return (
    <Ctx.Provider value={me}>
      <div className="min-h-screen md:p-4">
        <div className="flex min-h-[calc(100vh-2rem)] gap-5">
          <aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-[76px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto no-scrollbar rounded-[26px] bg-rail py-4 md:flex">
            <Link href={isInvestor ? "/me" : "/"} className="mb-3 grid h-11 w-11 shrink-0 place-items-center" aria-label="A+ Tradeplay">
              <Mark className="h-9 w-9" />
            </Link>
            <nav className="flex flex-col items-center gap-1.5" aria-label="Main">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} aria-label={n.label} aria-current={active(n.href) ? "page" : undefined}
                  className={`group relative grid h-11 w-11 shrink-0 place-items-center rounded-[14px] transition ${active(n.href) ? "bg-[#F3F4F6] text-[#0B0B0D]" : "text-[#9AA0AA] hover:bg-white/10 hover:text-white"}`}>
                  <Icon d={n.icon} className="h-5 w-5" />
                  <span className="pointer-events-none absolute left-full z-50 ml-3 whitespace-nowrap rounded-lg bg-solid px-2.5 py-1 text-xs font-medium text-solid-ink opacity-0 shadow-lg transition group-hover:opacity-100">{n.label}</span>
                </Link>
              ))}
            </nav>
            <div className="flex-1" />
            <ThemeToggle rail />
            <button onClick={() => supabase.auth.signOut()} aria-label="Sign out" className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] text-[#9AA0AA] hover:bg-white/10 hover:text-white">
              <Icon d={I.out} className="h-5 w-5" />
            </button>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-20 flex items-center justify-between gap-3 bg-bg/85 px-4 pb-2.5 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl md:static md:bg-transparent md:px-2 md:py-1 md:backdrop-blur-none">
              <Link href={isInvestor ? "/me" : "/"} className="flex items-center gap-2 md:hidden">
                <Logo className="h-8 w-8" />
                <span className="text-[15px] font-semibold tracking-tight">Tradeplay</span>
              </Link>
              <div className="hidden text-sm text-mute md:block">{today}</div>
              <div className="flex items-center gap-2">
                <div className="md:hidden"><ThemeToggle /></div>
                <div className="flex h-10 items-center gap-2.5 rounded-full bg-panel pl-1.5 pr-4 shadow-[var(--shadow)]">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-ink">{me.name.slice(0, 1).toUpperCase()}</span>
                  <span className="hidden text-sm sm:inline">{me.name}</span>
                  <span className="label hidden sm:inline">{me.role}</span>
                </div>
              </div>
            </header>
            <main className="pb-nav mx-auto w-full max-w-[1400px] flex-1 px-4 pt-3 sm:px-6 md:px-2 md:pb-10">{children}</main>
          </div>
        </div>
      </div>

      <nav className={`fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-30 grid ${isInvestor ? "grid-cols-4" : "grid-cols-5"} rounded-[22px] bg-rail px-1 shadow-2xl md:hidden`} aria-label="Main">
        {mobile.map((n) => (
          <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined} className={`flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition active:scale-95 ${active(n.href) ? "text-white" : "text-[#9AA0AA]"}`}>
            {n.href === "/calculator" ? (
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[#F2C14E] text-[#141518] shadow-lg"><Icon d={n.icon} className="h-5 w-5" /></span>
            ) : (
              <span className={`grid h-8 w-12 place-items-center rounded-full transition ${active(n.href) ? "bg-white/15" : ""}`}><Icon d={n.icon} className="h-5 w-5" /></span>
            )}
            {n.href !== "/calculator" && n.label}
          </Link>
        ))}
        {isInvestor ? (
          <button onClick={() => supabase.auth.signOut()} className="flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-[#9AA0AA]">
            <span className="grid h-8 w-12 place-items-center"><Icon d={I.out} className="h-5 w-5" /></span>
            Sign out
          </button>
        ) : (
          <button onClick={() => setMore((v) => !v)} aria-expanded={more} className={`flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium ${more || overflow.some((n) => active(n.href)) ? "text-white" : "text-[#9AA0AA]"}`}>
            <span className={`grid h-8 w-12 place-items-center rounded-full ${more ? "bg-white/15" : ""}`}><Icon d={I.menu} className="h-5 w-5" /></span>
            More
          </button>
        )}
      </nav>
      {more && <div className="fixed inset-0 z-20 md:hidden" onClick={() => setMore(false)} aria-hidden />}
      {more && (
        <div className="sheet-in card fixed inset-x-3 bottom-[calc(5.4rem+env(safe-area-inset-bottom))] z-30 grid grid-cols-2 gap-1 p-2 shadow-2xl md:hidden">
          {overflow.map((n) => (
            <Link key={n.href} href={n.href} className={`flex items-center gap-3 rounded-xl px-3 py-3.5 text-sm hover:bg-raised ${active(n.href) ? "bg-raised font-medium" : ""}`}>
              <Icon d={n.icon} /> {n.label}
            </Link>
          ))}
          <button onClick={() => supabase.auth.signOut()} className="col-span-2 flex items-center gap-3 rounded-xl px-3 py-3 text-sm text-mute hover:bg-raised">
            <Icon d={I.out} /> Sign out
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}
