"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Logo } from "@/components/Brand";

/** Staff must hold an aal2 session (TOTP). Enroll on first sign-in, challenge afterwards. */
export default function MfaGate({ onDone }: { onDone: () => void }) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(30 - (Math.floor(Date.now() / 1000) % 30));
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    const t = setInterval(() => setLeft(30 - (Math.floor(Date.now() / 1000) % 30)), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return setError(error.message);
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) return setFactorId(verified.id);
      for (const f of data.all.filter((f) => f.status !== "verified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
      const en = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "A+ Tradeplay" });
      if (en.error) return setError(en.error.message);
      setFactorId(en.data.id);
      setQr(en.data.totp.qr_code);
      setSecret(en.data.totp.secret);
    })();
  }, []);

  const code = digits.join("");
  const verify = async () => {
    if (!factorId || code.length !== 6) return;
    setBusy(true); setError(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    setBusy(false);
    if (error) { setError(error.message); setDigits(["", "", "", "", "", ""]); refs.current[0]?.focus(); return; }
    onDone();
  };
  const put = (i: number, v: string) => {
    const clean = v.replace(/\D/g, "");
    if (clean.length > 1) { // paste
      const next = clean.slice(0, 6).split("");
      setDigits([...next, ...Array(6 - next.length).fill("")]);
      refs.current[Math.min(5, next.length)]?.focus();
      return;
    }
    const next = [...digits]; next[i] = clean; setDigits(next);
    if (clean && i < 5) refs.current[i + 1]?.focus();
  };
  useEffect(() => { if (code.length === 6) verify(); }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "32px 16px", background: "var(--bg)" }}>
      <form onSubmit={(e) => { e.preventDefault(); verify(); }} className="card" style={{ width: "100%", maxWidth: 400, padding: 28, display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="row"><Logo className="h-9 w-9" /><b style={{ fontSize: 17 }}>A+ Tradeplay</b></div>
        <div className="col" style={{ gap: 4 }}>
          <h2 style={{ fontSize: 20, letterSpacing: "-0.02em" }}>{qr ? "Set up two-factor" : "Two-factor check"}</h2>
          <span className="muted" style={{ fontSize: 13 }}>{qr ? "Scan with your authenticator app, then enter the 6-digit code." : "Enter the 6-digit code from your authenticator app."}</span>
        </div>
        {qr && (
          <div className="col" style={{ alignItems: "center", gap: 8 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="Authenticator QR code" style={{ width: 168, height: 168, borderRadius: 14, background: "#fff", padding: 8 }} />
            {secret && <code className="mono faint" style={{ fontSize: 11, wordBreak: "break-all", textAlign: "center" }}>{secret}</code>}
          </div>
        )}
        <div role="group" aria-label="6-digit code" style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0,1fr))", gap: 8 }}>
          {digits.map((d, i) => (
            <input key={i} ref={(el) => { refs.current[i] = el; }} aria-label={`Digit ${i + 1}`} inputMode="numeric" autoComplete={i === 0 ? "one-time-code" : "off"} maxLength={6} value={d} autoFocus={i === 0}
              onChange={(e) => put(i, e.target.value)} onKeyDown={(e) => { if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus(); }}
              className="mono" style={{ height: 52, borderRadius: 12, border: "1px solid var(--line-2)", background: "var(--surface-2)", textAlign: "center", fontSize: 20, fontWeight: 600, width: "100%", outline: 0 }} />
          ))}
        </div>
        <div className="between" style={{ fontSize: 12 }}><span className="faint">Code refreshes every 30 s</span><span className="mono acc">0:{String(left).padStart(2, "0")}</span></div>
        {error && <p className="down" style={{ fontSize: 12.5 }}>{error}</p>}
        <button className="btn pri lg block" disabled={busy || code.length !== 6 || !factorId}>{busy ? "Verifying…" : "Verify & open dashboard"}</button>
        <div className="between" style={{ fontSize: 12 }}><button type="button" className="btn ghost sm" onClick={() => supabase.auth.signOut()}>Back</button><span className="faint">Lost your device? Ask the owner to reset it</span></div>
      </form>
    </div>
  );
}
