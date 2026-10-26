import { PROMPTS, aiConfigured, complete, type AiTask } from "@/lib/server/ai";
import { staffFromRequest, unauthorized } from "@/lib/server/auth";
import { errMsg } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/ai { task: ask|brief|news|review|investor, desk?, question?, context }
 * Narrative only: explains engine output, reads headlines, reviews trades. Staff with 2FA.
 */
export async function POST(req: Request) {
  const db = await staffFromRequest(req);
  if (!db) return unauthorized();
  if (!aiConfigured().provider) return Response.json({ error: "AI is not configured — add OPENROUTER_API_KEY in Vercel" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { task?: string; desk?: string; question?: string; context?: unknown } | null;
  const task = (body?.task ?? "ask") as AiTask;
  if (!(task in PROMPTS)) return Response.json({ error: "unknown task" }, { status: 400 });
  const desk = body?.desk === "btc" ? "bitcoin" : "gold";
  const question = String(body?.question ?? "").slice(0, 1500).trim();
  if (task === "ask" && !question) return Response.json({ error: "Ask a question" }, { status: 400 });

  const settings = await db.from("app_settings").select("integrations").eq("id", 1).maybeSingle();
  const model = (settings.data?.integrations as { ai_model?: string } | null)?.ai_model || null;
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
