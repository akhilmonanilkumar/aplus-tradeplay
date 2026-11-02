import { hasSecret, hasVaultSecret, serviceClient, staffFromRequest } from "@/lib/server/auth";
import { runStrategyAgent } from "@/lib/server/strategyAgent";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** POST /api/league/agent → run the strategy development agent. pg_cron (Vault secret), the autopilot secret, or staff. */
export async function POST(req: Request) {
  const staff = await staffFromRequest(req);
  const scheduled = !staff && (hasSecret(req, process.env.AUTOPILOT_SECRET) || (await hasVaultSecret(req)));
  const db = staff ?? (scheduled ? serviceClient() : null);
  if (!db) return Response.json({ error: "unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { trigger?: string };
  try {
    return Response.json(await runStrategyAgent(db, { trigger: staff ? "manual" : body.trigger ?? "schedule", budgetMs: 230_000 }));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
