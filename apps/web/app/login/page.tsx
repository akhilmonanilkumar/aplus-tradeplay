"use client";

import { useState } from "react";
import { configured, supabase } from "@/lib/supabase";
import { Logo } from "@/components/Brand";
import { Segmented } from "@/components/ui";

export default function Login() {
  const [mode, setMode] = useState<"password" | "link">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    if (mode === "password") {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      setBusy(false);
      if (error) return setMsg({ ok: false, text: error.message });
      window.location.replace("/");
    } else {
      const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: `${location.origin}/`, shouldCreateUser: false } });
      setBusy(false);
      setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "Check your inbox." });
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-7">
        <div className="flex items-center gap-3">
          <Logo className="h-11 w-11" />
          <div>
            <div className="text-lg font-semibold tracking-tight">A+ Tradeplay</div>
            <div className="label">Invite only</div>
          </div>
        </div>
        <div className="mt-6">
          <Segmented value={mode} onChange={setMode} options={[{ v: "password", l: "Password" }, { v: "link", l: "Email link" }]} />
        </div>
        <input className="input mt-4" type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        {mode === "password" && (
          <input className="input mt-3" type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        )}
        {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>}
        <button className="btn-accent mt-5 w-full" disabled={busy || !configured}>{busy ? "…" : mode === "password" ? "Sign in" : "Send link"}</button>
      </form>
    </div>
  );
}
