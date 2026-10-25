"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Logo } from "@/components/Brand";

/** Staff must hold an aal2 session (TOTP). Enroll on first sign-in, challenge afterwards. */
export default function MfaGate({ onDone }: { onDone: () => void }) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return setError(error.message);
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) return setFactorId(verified.id);
      // Remove stale unverified factors, then enroll a fresh one.
      for (const f of data.all.filter((f) => f.status !== "verified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
      const en = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "A+ Tradeplay" });
      if (en.error) return setError(en.error.message);
      setFactorId(en.data.id);
      setQr(en.data.totp.qr_code);
      setSecret(en.data.totp.secret);
    })();
  }, []);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!factorId) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (error) return setError(error.message);
    onDone();
  };

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={verify} className="card w-full max-w-sm p-7">
        <Logo className="h-10 w-10" />
        <h1 className="mt-5 text-xl font-semibold">{qr ? "Set up two-factor" : "Two-factor code"}</h1>
        {qr && (
          <div className="mt-5 flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="Authenticator QR code" className="h-44 w-44 rounded-xl bg-white p-2" />
            {secret && <code className="num break-all text-center text-xs text-mute">{secret}</code>}
          </div>
        )}
        <input className="input num mt-5 text-center text-lg tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
        {error && <p className="mt-3 text-sm text-down">{error}</p>}
        <button className="btn-accent mt-5 w-full" disabled={busy || code.length !== 6 || !factorId}>{busy ? "Verifying…" : "Verify"}</button>
        <button type="button" className="btn mt-2 w-full text-mute" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </form>
    </div>
  );
}
