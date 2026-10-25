import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/** Staff (aal2) invite an investor by email. Needs SUPABASE_SERVICE_ROLE_KEY on the server. */
export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon || !service) return Response.json({ error: "Invites are not configured on the server" }, { status: 503 });

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const asUser = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const staff = await asUser.rpc("is_staff");
  if (staff.error || staff.data !== true) return Response.json({ error: "Staff with two-factor only" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { investorId?: string } | null;
  if (!body?.investorId) return Response.json({ error: "investorId required" }, { status: 400 });
  const inv = await asUser.from("investors").select("email, user_id").eq("id", body.investorId).maybeSingle();
  if (inv.error || !inv.data?.email) return Response.json({ error: "Investor has no email" }, { status: 400 });
  if (inv.data.user_id) return Response.json({ error: "Already linked" }, { status: 409 });

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const origin = process.env.APP_URL || new URL(req.url).origin;
  const { error } = await admin.auth.admin.inviteUserByEmail(inv.data.email, { redirectTo: `${origin}/me` });
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ ok: true });
}
