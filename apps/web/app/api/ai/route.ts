import { PROMPTS, aiConfigured, chat, complete, type AiTask, type ChatTurn } from "@/lib/server/ai";
import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { errMsg } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const DESK_NAMES: Record<string, string> = { gold: "gold", btc: "bitcoin", fx: "forex (EUR/USD, USD/JPY)", indices: "index (Nasdaq-100, S&P 500, Nifty 50)" };
export const maxDuration = 60;

/**
 * POST /api/ai { task: ask|brief|news|review|investor, desk?, question?, context }
 *            { task: "chat", desk, context, turns: [{ role, text, images?: dataURL[] }] }
 * Narrative only: explains engine output, reads headlines and screenshots, reviews trades. Staff with 2FA.
 */
export async function POST(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  if (!aiConfigured().provider) return Response.json({ error: "AI is not configured — add OPENROUTER_API_KEY in Vercel" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { task?: string; desk?: string; question?: string; context?: unknown; turns?: ChatTurn[] } | null;
  const task = (body?.task ?? "ask") as AiTask;
  if (!(task in PROMPTS)) return Response.json({ error: "unknown task" }, { status: 400 });
  const desk = DESK_NAMES[body?.desk ?? ""] ?? "gold";
  const question = String(body?.question ?? "").slice(0, 1500).trim();
  if (task === "ask" && !question) return Response.json({ error: "Ask a question" }, { status: 400 });

  const settings = await db.from("app_settings").select("integrations").eq("id", 1).maybeSingle();
  const model = (settings.data?.integrations as { ai_model?: string } | null)?.ai_model || null;
  if (task === "chat") {
    // Last 12 turns; screenshots only where the client still holds them, at most 4 per request.
    let budget = 4;
    const turns = (Array.isArray(body?.turns) ? body!.turns : []).slice(-12).reverse().map((t) => {
      const imgs = (Array.isArray(t.images) ? t.images : []).filter((u) => typeof u === "string" && u.length < 2_000_000).slice(0, Math.max(0, budget));
      budget -= imgs.length;
      return { role: t.role === "assistant" ? "assistant" as const : "user" as const, text: String(t.text ?? "").slice(0, 4000), images: imgs };
    }).reverse();
    if (!turns.length || turns.at(-1)!.role !== "user") return Response.json({ error: "Say something first" }, { status: 400 });
    // Turns must alternate, starting with the user.
    const clean: ChatTurn[] = [];
    for (const t of turns) { if (!clean.length && t.role !== "user") continue; const prev = clean.at(-1); if (prev?.role === t.role) { prev.text += `\n\n${t.text}`; prev.images = [...(prev.images ?? []), ...(t.images ?? [])]; } else clean.push(t); }
    try {
      const out = await chat({
        system: `${PROMPTS.chat.replaceAll("${desk}", desk)}\n\nLive desk state (JSON):\n${JSON.stringify(body?.context ?? {}).slice(0, 16000)}`,
        turns: clean, maxTokens: 900, model,
      });
      return Response.json({ answer: out.text || "No answer.", model: out.model });
    } catch (e) {
      return Response.json({ error: errMsg(e) }, { status: 502 });
    }
  }
  try {
    const out = await complete({
      system: PROMPTS[task].replaceAll("${desk}", desk),
      user: `Context (JSON):\n${JSON.stringify(body?.context ?? {}).slice(0, 16000)}${question ? `\n\nQuestion: ${question}` : ""}`,
      maxTokens: task === "news" ? 900 : 600,
      model,
      json: task === "news",
    });
    if (task === "news") {
      try { return Response.json({ ...JSON.parse(out.text.replace(/^```(json)?|```$/g, "").trim()), model: out.model }); }
      catch { return Response.json({ summary: out.text, model: out.model }); }
    }
    return Response.json({ answer: out.text || "No answer.", model: out.model });
  } catch (e) {
    return Response.json({ error: errMsg(e) }, { status: 502 });
  }
}
