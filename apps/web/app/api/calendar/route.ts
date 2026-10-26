import { loadCalendar } from "@/lib/server/news";
import { errMsg, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/** GET /api/calendar → this week's and next week's economic events (Forex Factory). */
export async function GET() {
  try {
    return json(await loadCalendar(), 1800);
  } catch (e) {
    return json({ error: errMsg(e) }, 0, 502);
  }
}
