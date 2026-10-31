import { aiConfigured } from "@/lib/server/ai";
import { staffFromRequest, unauthorized } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

/** Which server-side keys are present (never their values). */
export async function GET(req: Request) {
  if (!(await staffFromRequest(req))) return unauthorized();
  const has = (k: string) => !!process.env[k]?.trim();
  const ai = aiConfigured();
  return Response.json({
    ai: { provider: ai.provider, model: ai.model },
    keys: {
      OPENROUTER_API_KEY: has("OPENROUTER_API_KEY"),
      TELEGRAM_BOT_TOKEN: has("TELEGRAM_BOT_TOKEN"),
      TELEGRAM_CHAT_IDS: has("TELEGRAM_CHAT_IDS"),
      OANDA_API_KEY: has("OANDA_API_KEY"),
      OANDA_ACCOUNT_ID: has("OANDA_ACCOUNT_ID"),
      FRED_API_KEY: has("FRED_API_KEY"),
      FINNHUB_API_KEY: has("FINNHUB_API_KEY"),
      SUPABASE_SERVICE_ROLE_KEY: has("SUPABASE_SERVICE_ROLE_KEY"),
      AUTOPILOT_SECRET: has("AUTOPILOT_SECRET") || has("CRON_SECRET"),
    },
  });
}
