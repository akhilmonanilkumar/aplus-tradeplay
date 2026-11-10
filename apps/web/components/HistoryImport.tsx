"use client";

import { useState } from "react";
import { staffPost } from "@/lib/market";
import { dateShort } from "@/lib/fmt";
import { fromCTraderSymbol, parseCTraderHistory, type ParsedHistory } from "@/lib/ctraderHistory";

/**
 * Account detail: bring in trades taken earlier on cTrader. Upload the History export (cTrader: History tab →
 * right-click → Export, or the statement CSV): it is previewed here, then imported once per trade and linked to
 * the logged setup it was taken from. Accounts with a cTrader login can also pull the last 90 days from the API.
 */

type Result = { imported: number; duplicates: number; matched: number; noStop: number; skipped: number; found: number };

export function HistoryImport({ accountId, linked, onDone }: { accountId: string; linked: boolean; onDone: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string; p: ParsedHistory } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const pick = async (f: File | undefined) => {
    setMsg(null); setFile(null);
    if (!f) return;
    if (f.size > 4_000_000) return setMsg({ ok: false, text: "File too large (4 MB at most). Export a shorter date range." });
    if (/\.xlsx?$/i.test(f.name)) return setMsg({ ok: false, text: "Excel files are not read here: in cTrader export the history as CSV, or open it in Excel and save as CSV." });
    const text = await f.text();
    const p = parseCTraderHistory(text);
    if (p.errors.length) return setMsg({ ok: false, text: `${p.errors.join("; ")}.${p.columns.length ? ` Columns found: ${p.columns.slice(0, 12).join(", ")}` : ""}` });
    if (!p.rows.length) return setMsg({ ok: false, text: "No closed trades found in this file." });
    setFile({ name: f.name, text, p });
  };

  const run = async () => {
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const r = await staffPost<Result>("/api/accounts/import", { accountId, text: file.text });
      setMsg({ ok: true, text: [`${r.imported} trade${r.imported === 1 ? "" : "s"} imported`, r.duplicates ? `${r.duplicates} already in the journal` : "", r.matched ? `${r.matched} matched to a logged setup` : "", r.noStop ? `${r.noStop} without a stop (P&L counted, R not)` : "", r.skipped ? `${r.skipped} rows skipped` : ""].filter(Boolean).join(" · ") });
      setFile(null);
      onDone();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };

  const pull = async () => {
    setBusy(true); setMsg(null);
    try { const r = await staffPost<{ note: string }>("/api/cfd/positions", { days: 90 }); setMsg({ ok: true, text: r.note }); onDone(); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };

  const rows = file?.p.rows ?? [];
  const markets = [...new Set(rows.map((r) => fromCTraderSymbol(r.symbol)))];
  const net = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
  return (
    <div>
      <div className="lbl-u" style={{ margin: "16px 0 6px" }}>Trade history</div>
      <p className="faint" style={{ fontSize: 12, margin: "0 0 8px" }}>Upload the cTrader History export (CSV) to bring in trades taken earlier. Each trade is imported once and linked to the setup it came from.</p>
      <div className="row" style={{ gap: 6 }}>
        <label className="btn sm" style={{ cursor: "pointer" }}>
          Choose file
          <input type="file" accept=".csv,.txt,.tsv,text/csv" style={{ display: "none" }} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {linked && <button type="button" className="btn ghost sm" disabled={busy} onClick={pull}>Pull 90 days from cTrader</button>}
      </div>
      {file && (
        <div className="hist-pv">
          <div style={{ fontSize: 12.5 }}><b style={{ fontWeight: 500 }}>{file.name}</b></div>
          <div className="faint" style={{ fontSize: 12 }}>
            {rows.length} closed trade{rows.length === 1 ? "" : "s"} · {dateShort(new Date(Math.min(...rows.map((r) => r.openedAt))).toISOString())} – {dateShort(new Date(Math.max(...rows.map((r) => r.closedAt))).toISOString())} · {markets.join(", ")}
            {rows.some((r) => r.pnl !== null) ? ` · net ${net >= 0 ? "+" : ""}${net.toFixed(2)}` : ""}{file.p.skipped ? ` · ${file.p.skipped} rows skipped` : ""}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button type="button" className="btn pri sm" disabled={busy} onClick={run}>{busy ? "Importing…" : `Import ${rows.length}`}</button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => setFile(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p className={msg.ok ? "up" : "down"} style={{ fontSize: 12, margin: "8px 0 0" }}>{msg.text}</p>}
    </div>
  );
}
