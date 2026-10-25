import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * Copilot agent: explains the engine's gate output in plain words. It never decides GO —
 * the verdict comes from the deterministic engine and is passed in as context.
 * Needs ANTHROPIC_API_KEY on the server; staff (aal2) only.
 */
export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key || !url || !anon) return Response.json({ error: "Agent is not configured (ANTHROPIC_API_KEY)" }, { status: 503 });
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const asUser = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const staff = await asUser.rpc("is_staff");
  if (staff.error || staff.data !== true) return Response.json({ error: "Staff with two-factor only" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { question?: string; context?: unknown } | null;
  const question = String(body?.question ?? "").slice(0, 1000).trim();
  if (!question) return Response.json({ error: "Ask a question" }, { status: 400 });

  const system = [
    "You are the A+ Tradeplay copilot agent. You explain the engine's A+ gate output for XAUUSD and BTCUSDT.P.",
    "The edge: direction (HTF) → location (fresh POI in the correct half) → execution (liquidity sweep + 5M body-close market shift, inside London Q or NY Q, news clear, ≥3R to a real target, structural stop).",
    "Never change or override the engine's verdict. Never suggest chasing, widening stops, stretching targets or trading outside the rules.",
    "Answer in at most 5 short sentences, with exact prices from the context. If the context lacks something, say so.",
  ].join(" ");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.AGENT_MODEL || "claude-sonnet-5-5",
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: `Engine context (JSON):\n${JSON.stringify(body?.context ?? {}).slice(0, 12000)}\n\nQuestion: ${question}` }],
    }),
  });
  if (!res.ok) return Response.json({ error: `Agent error ${res.status}` }, { status: 502 });
  const j = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
  return Response.json({ answer: text || "No answer." });
}
