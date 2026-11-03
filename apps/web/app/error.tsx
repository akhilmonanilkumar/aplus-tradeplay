"use client";

import Link from "next/link";
import { useEffect } from "react";

/** A page crashed: say so plainly and offer a retry, instead of a blank screen. */
export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <section className="card" style={{ maxWidth: 560, margin: "48px auto" }}>
      <div className="ch"><h3>This page hit an error</h3></div>
      <p className="muted" style={{ fontSize: 13 }}>Nothing was sent to any venue. Try again; if it keeps happening, the message below says what failed.</p>
      <pre className="mono faint" style={{ fontSize: 12, whiteSpace: "pre-wrap", margin: "12px 0", padding: 10, borderRadius: 8, background: "var(--surface-2)" }}>{msg.slice(0, 400)}</pre>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn pri sm" onClick={() => retry()}>Try again</button>
        <Link className="btn sm" href="/">Dashboard</Link>
      </div>
    </section>
  );
}
