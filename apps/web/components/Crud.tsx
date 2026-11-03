"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/ui";

/**
 * Shared edit / delete controls: a pair of small icon buttons for a row or a detail panel, and a
 * delete confirmation that says what goes with the entry and, for important records, asks for the
 * name to be typed. Database refusals (a record still in use) come back as plain sentences.
 */

const PENCIL = "M4 20h4L19 9l-4-4L4 16zM14 6l4 4";
const TRASH = "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6";

export function EditDeleteButtons({ onEdit, onDelete, label, size = "sm" }: { onEdit?: () => void; onDelete?: () => void; label: string; size?: "sm" | "xs" }) {
  return (
    <span className="row crud" style={{ gap: 4, flexWrap: "nowrap" }} onClick={(e) => e.stopPropagation()}>
      {onEdit && <button type="button" className={`btn ghost ${size} icon`} aria-label={`Edit ${label}`} title="Edit" onClick={onEdit}><Icon d={PENCIL} /></button>}
      {onDelete && <button type="button" className={`btn ghost ${size} icon del`} aria-label={`Delete ${label}`} title="Delete" onClick={onDelete}><Icon d={TRASH} /></button>}
    </span>
  );
}

/** Turn Postgres refusals into sentences. */
export function friendlyDbError(msg: string, inUse = "It is still used by other records; remove those first."): string {
  if (/foreign key|violates.*constraint.*references|23503/i.test(msg)) return inUse;
  if (/row-level security|permission denied/i.test(msg)) return "You do not have permission to change this.";
  return msg;
}

export function ConfirmDelete({ title, children, confirmName, inUse, onConfirm, onClose }: {
  title: string; children?: ReactNode; confirmName?: string; inUse?: string;
  onConfirm: () => Promise<string | null | undefined>; onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = !confirmName || typed.trim() === confirmName.trim();
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const e = await onConfirm();
      if (e) setErr(friendlyDbError(e, inUse)); else onClose();
    } catch (x) { setErr(friendlyDbError((x as Error).message, inUse)); } finally { setBusy(false); }
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="ch"><h3>{title}</h3><span className="sp" /><button type="button" className="btn ghost sm" onClick={onClose}>Close</button></div>
        <div className="muted" style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 8 }}>{children}<span>This cannot be undone.</span></div>
        {confirmName && (
          <label className="fld" style={{ marginTop: 12 }}><span>Type <b>{confirmName}</b> to confirm</span><div className="inp txt"><input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} /></div></label>
        )}
        {err && <p className="down" style={{ fontSize: 12.5, marginTop: 10 }}>{err}</p>}
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
          <button type="button" className="btn sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn sm danger" disabled={!ok || busy} onClick={go}>{busy ? "Deleting…" : "Delete"}</button>
        </div>
      </div>
    </div>
  );
}
