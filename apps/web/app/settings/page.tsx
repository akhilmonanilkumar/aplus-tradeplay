"use client";

import { useEffect, useState } from "react";
import { EDGE_RULES } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { useMe } from "@/components/Shell";
import { dateShort } from "@/lib/fmt";
import { Badge, Card, ErrorNote, PageHead, Row, Table } from "@/components/ui";

type EdgeConfig = { id: string; version: string; active: boolean; config: Record<string, unknown>; created_at: string };
type Audit = { id: number; entity: string; action: string; at: string };
type Member = { user_id: string; role: string; display_name: string; created_at: string };

export default function Settings() {
  const me = useMe();
  const edge = useRows<EdgeConfig>({ table: "edge_configs", order: "created_at" });
  const audit = useRows<Audit>({ table: "audit_log", select: "id,entity,action,at", order: "at", limit: 20 });
  const members = useRows<Member>({ table: "members", order: "created_at", ascending: true });
  const [factors, setFactors] = useState<{ id: string; friendly_name?: string; status: string; created_at: string }[]>([]);
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data }) => setFactors((data?.all ?? []) as typeof factors));
  }, []);

  const changePw = async () => {
    if (pw.length < 12) return setMsg({ ok: false, text: "Use at least 12 characters" });
    const { error } = await supabase.auth.updateUser({ password: pw });
    setPw("");
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "Password updated" });
  };

  const active = (edge.rows ?? []).find((e) => e.active);

  return (
    <div>
      <PageHead title="Settings" />
      <ErrorNote error={edge.error} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Security">
          <div className="divide-y divide-line">
            <Row k="Signed in" v={me.session.user.email ?? "—"} />
            <Row k="Role" v={me.role} />
            {factors.map((f) => <Row key={f.id} k={`TOTP · ${f.friendly_name ?? "app"}`} v={<Badge tone={f.status === "verified" ? "up" : "warn"}>{f.status}</Badge>} />)}
          </div>
          <div className="mt-4 flex gap-2">
            <input className="input" type="password" autoComplete="new-password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <button className="btn-ghost shrink-0" onClick={changePw} disabled={!pw}>Update</button>
          </div>
          {msg && <p className={`mt-2 text-sm ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>}
        </Card>

        <Card title="Edge" right={active ? <Badge tone="accent">v{active.version}</Badge> : null}>
          <div className="divide-y divide-line">
            <Row k="Min R:R" v={`${EDGE_RULES.minRR}R`} />
            <Row k="A+ trades / day" v={EDGE_RULES.maxAPlusTradesPerDay} />
            <Row k="Stop after losses" v={EDGE_RULES.stopAfterLosses} />
            <Row k="News block" v={`±${EDGE_RULES.newsBlockMinutes} min`} />
            <Row k="BTC min stop" v={`${EDGE_RULES.btcMinStopPct}%`} />
            <Row k="Sessions" v="London Q 02–05 · NY Q 07–10 ET" />
          </div>
        </Card>

        <Card title="Team">
          <Table head={["Member", "Role", "Since"]}>
            {(members.rows ?? []).map((m) => (
              <tr key={m.user_id}>
                <td>{m.display_name || m.user_id.slice(0, 8)}</td>
                <td><Badge tone={m.role === "owner" ? "accent" : m.role === "admin" ? "chart" : "mute"}>{m.role}</Badge></td>
                <td className="num text-mute">{dateShort(m.created_at)}</td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Audit log">
          <Table head={["When", "Table", "Action"]}>
            {(audit.rows ?? []).map((a) => (
              <tr key={a.id}>
                <td className="num text-mute">{new Date(a.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</td>
                <td>{a.entity}</td>
                <td className="text-mute">{a.action}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
}
