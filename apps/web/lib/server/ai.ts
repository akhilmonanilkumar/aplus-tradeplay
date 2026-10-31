import "server-only";

/**
 * LLM access for narrative tasks only (briefs, explanations, news reads, reviews).
 * OpenRouter is the default gateway, so the model can be switched from Settings
 * without code changes. The deterministic engine always decides GO; the model never does.
 */

export const DEFAULT_AI_MODEL = "anthropic/claude-sonnet-4.5";

export function aiConfigured(): { provider: "openrouter" | "anthropic" | null; model: string } {
  if (process.env.OPENROUTER_API_KEY) return { provider: "openrouter", model: process.env.OPENROUTER_MODEL || DEFAULT_AI_MODEL };
  if (process.env.ANTHROPIC_API_KEY) return { provider: "anthropic", model: process.env.AGENT_MODEL || "claude-sonnet-5-5" };
  return { provider: null, model: "" };
}

export async function complete(p: { system: string; user: string; maxTokens?: number; model?: string | null; json?: boolean }): Promise<{ text: string; model: string }> {
  const cfg = aiConfigured();
  if (!cfg.provider) throw new Error("AI is not configured — add OPENROUTER_API_KEY");
  const model = p.model || cfg.model;
  if (cfg.provider === "openrouter") {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.APP_URL || "https://tradeplay.cloud",
        "X-Title": "A+ Tradeplay",
      },
      body: JSON.stringify({
        model,
        max_tokens: p.maxTokens ?? 600,
        temperature: 0.2,
        messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
        ...(p.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
    return { text: j.choices?.[0]?.message?.content?.trim() ?? "", model: j.model ?? model };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: p.maxTokens ?? 600, system: p.system, messages: [{ role: "user", content: p.user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const j = (await res.json()) as { content?: { type: string; text?: string }[] };
  return { text: (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim(), model };
}

/** One chat turn; images are data URLs (image/jpeg|png|webp;base64). */
export interface ChatTurn { role: "user" | "assistant"; text: string; images?: string[] }

const dataUrl = (u: string) => {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(u);
  return m ? { media: m[1]!, data: m[2]! } : null;
};

/** Multi-turn chat with optional screenshots (vision models). */
export async function chat(p: { system: string; turns: ChatTurn[]; maxTokens?: number; model?: string | null }): Promise<{ text: string; model: string }> {
  const cfg = aiConfigured();
  if (!cfg.provider) throw new Error("AI is not configured — add OPENROUTER_API_KEY");
  const model = p.model || cfg.model;
  if (cfg.provider === "openrouter") {
    const messages = [
      { role: "system", content: p.system },
      ...p.turns.map((t) => ({
        role: t.role,
        content: t.images?.length
          ? [{ type: "text", text: t.text || "(screenshot)" }, ...t.images.filter((u) => dataUrl(u)).map((u) => ({ type: "image_url", image_url: { url: u } }))]
          : t.text,
      })),
    ];
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": process.env.APP_URL || "https://tradeplay.cloud",
        "X-Title": "A+ Tradeplay",
      },
      body: JSON.stringify({ model, max_tokens: p.maxTokens ?? 900, temperature: 0.3, messages }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
    return { text: j.choices?.[0]?.message?.content?.trim() ?? "", model: j.model ?? model };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: p.maxTokens ?? 900, system: p.system,
      messages: p.turns.map((t) => ({
        role: t.role,
        content: [
          ...(t.images ?? []).map(dataUrl).filter((x): x is { media: string; data: string } => !!x).map((x) => ({ type: "image", source: { type: "base64", media_type: x.media, data: x.data } })),
          { type: "text", text: t.text || "(screenshot)" },
        ],
      })),
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const j = (await res.json()) as { content?: { type: string; text?: string }[] };
  return { text: (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim(), model };
}

const EDGE = [
  "The edge: direction (HTF trend) → location (fresh 15M POI in the correct half of the HTF dealing range) → execution (liquidity sweep + 5M body-close market shift, inside London Q 02:00–05:00 ET or NY Q 07:00–10:00 ET, ±15 min clear of high-impact news, ≥3R to a real structural target, structural stop).",
  "Never override the engine's verdict, never suggest chasing, widening stops, stretching targets, trading outside the windows or sizing up after losses.",
].join(" ");

export const PROMPTS = {
  chat: `You are the desk agent for a private trading firm's ${"${desk}"} desk, talking with the trader in a chat. ${EDGE} You see the engine's live state as JSON (gate, plan, structure, liquidity, news, open trades) and sometimes screenshots the trader shares (charts, broker tickets, positions, P&L). Read screenshots carefully: name the instrument, timeframe, levels and what is drawn, then relate them to the engine's state; if a screenshot disagrees with the engine, say so and trust the engine for decisions. Be concise and specific with exact prices: short paragraphs or bullets, no filler. Say plainly when something is missing or unclear. You explain and flag risk; you never place, approve or size trades.`,
  ask: `You are the desk analyst for a private trading firm's ${"${desk}"} desk. ${EDGE} Answer the trader's question in at most 6 short sentences using exact prices from the JSON context. If the context lacks something, say so.`,
  brief: `You are the desk analyst for a private trading firm. ${EDGE} Write a pre-session brief from the engine JSON: 1) bias and why (HTF range, half, magnet), 2) what must happen for an A+ trade and where, 3) what the context says (dollar, yields, OI/funding, correlations, news), 4) invalidation. Max 140 words, plain sentences, exact prices. Context informs confidence, it never changes the gate.`,
  news: `You read market headlines for a ${"${desk}"} trading desk. Return JSON {"overall":"bullish|bearish|neutral","score":-100..100,"summary":"2 sentences","items":[{"i":index,"tone":"bullish|bearish|neutral","why":"≤12 words"}]} for the most market-moving headlines (max 8). Judge impact on the asset's price over the next 24 h.`,
  review: `You review a closed trade for a private trading firm. ${EDGE} In ≤5 sentences: did it follow the plan, what was the strongest part, the main leak, and one if-then rule for next time. Judge process over outcome.`,
  investor: `You write a short, factual monthly note to an investor about their managed account. Use only the numbers in the JSON. 4–6 sentences: balance and growth, net P&L, fees, drawdown, what drove results. No promises, no forecasts, educational tone.`,
} as const;

export type AiTask = keyof typeof PROMPTS;
