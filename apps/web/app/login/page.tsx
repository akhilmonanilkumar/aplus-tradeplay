"use client";

import { useState } from "react";
import { configured, supabase } from "@/lib/supabase";
import { Logo } from "@/components/Brand";

export default function Login() {
  const [who, setWho] = useState<"owner" | "investor">("owner");
  const [mode, setMode] = useState<"password" | "link" | "forgot">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const em = email.trim();
    if (mode === "password") {
      const { error } = await supabase.auth.signInWithPassword({ email: em, password });
      setBusy(false);
      if (error) return setMsg({ ok: false, text: error.message });
      window.location.replace(who === "investor" ? "/me" : "/");
      return;
    }
    if (mode === "link") {
      const { error } = await supabase.auth.signInWithOtp({ email: em, options: { emailRedirectTo: `${location.origin}${who === "investor" ? "/me" : "/"}`, shouldCreateUser: false } });
      setBusy(false);
      return setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "Check your inbox for the sign-in link." });
    }
    const { error } = await supabase.auth.resetPasswordForEmail(em, { redirectTo: `${location.origin}/settings` });
    setBusy(false);
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "If that email has an account, a reset link is on its way." });
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", display: "flex", flexWrap: "wrap" }}>
      <section className="hide-m" style={{ flex: "1 1 520px", padding: 48, display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 32, borderRight: "1px solid var(--line)", background: "var(--surface)" }}>
        <div className="row"><Logo className="h-9 w-9" /><b style={{ fontSize: 18, letterSpacing: "-0.02em" }}>A+ Tradeplay</b></div>
        <div className="col" style={{ gap: 16, maxWidth: 480 }}>
          <h1 style={{ fontSize: 38, lineHeight: 1.08, letterSpacing: "-0.035em", fontWeight: 600 }}>One edge. Seven boxes. No exceptions.</h1>
          <div className="col" style={{ gap: 8, marginTop: 8 }}>
            <div className="gate"><span className="gi p">1</span><span style={{ fontSize: 13 }}>HTF aligned</span><span className="chip up">pass</span></div>
            <div className="gate"><span className="gi p">4</span><span style={{ fontSize: 13 }}>Liquidity swept</span><span className="chip up">pass</span></div>
            <div className="gate"><span className="gi w">5</span><span style={{ fontSize: 13 }}>Market shift</span><span className="chip warn">waiting</span></div>
          </div>
        </div>
        <span className="faint" style={{ fontSize: 12 }}>Private, invite-only service · not investment advice · trading involves risk of loss</span>
      </section>

      <section style={{ flex: "1 1 420px", display: "grid", placeItems: "center", padding: "32px 16px" }}>
        <form onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 400, padding: 28, display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="row show-m"><Logo className="h-9 w-9" /><b style={{ fontSize: 17 }}>A+ Tradeplay</b></div>
          <div className="col" style={{ gap: 4 }}>
            <h2 style={{ fontSize: 20, letterSpacing: "-0.02em" }}>{mode === "forgot" ? "Reset password" : "Sign in"}</h2>
            <span className="muted" style={{ fontSize: 13 }}>Use the email your invite was sent to.</span>
          </div>
          {mode !== "forgot" && (
            <div className="seg" role="group" aria-label="Account type" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              <button type="button" className={who === "owner" ? "on" : ""} onClick={() => setWho("owner")}>Owner</button>
              <button type="button" className={who === "investor" ? "on" : ""} onClick={() => setWho("investor")}>Investor</button>
            </div>
          )}
          <label className="fld"><span>Email</span><div className="inp txt"><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div></label>
          {mode === "password" && <label className="fld"><span>Password</span><div className="inp txt"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div></label>}
          {msg && <p className={msg.ok ? "up" : "down"} style={{ fontSize: 12.5 }}>{msg.text}</p>}
          <button className="btn pri lg block" disabled={busy || !configured}>{busy ? "…" : mode === "password" ? "Continue" : mode === "link" ? "Email me a sign-in link" : "Send reset link"}</button>
          {mode === "password" ? <button type="button" className="btn lg block" onClick={() => { setMode("link"); setMsg(null); }}>Sign in with an email link</button> : <button type="button" className="btn lg block" onClick={() => { setMode("password"); setMsg(null); }}>Use password</button>}
          <div className="between" style={{ fontSize: 12 }}>
            <button type="button" className="muted" style={{ background: "none", border: 0, padding: 0 }} onClick={() => { setMode("forgot"); setMsg(null); }}>Forgot password?</button>
            <span className="faint">No sign-ups · invite only</span>
          </div>
        </form>
      </section>
    </div>
  );
}
