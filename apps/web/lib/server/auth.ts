import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

const url = () => process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anon = () => process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** Supabase client acting as the caller; null unless the caller is staff signed in with 2FA. */
export async function staffFromRequest(req: Request): Promise<SupabaseClient | null> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !url() || !anon()) return null;
  const db = createClient(url(), anon(), { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const staff = await db.rpc("is_staff");
  return !staff.error && staff.data === true ? db : null;
}

/** Service-role client for jobs (autopilot, webhooks). Null when not configured. */
export function serviceClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url() || !key) return null;
  return createClient(url(), key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Constant-time check of a shared secret from `Authorization: Bearer …` or `?key=`. */
export function hasSecret(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? new URL(req.url).searchParams.get("key") ?? "";
  const a = Buffer.from(got), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The scheduler's bearer token, checked against the secret pg_cron reads from Supabase Vault
 * (`autopilot_secret_ok`, service role only). The secret is generated in the database and never copied.
 */
export async function hasVaultSecret(req: Request): Promise<boolean> {
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const db = serviceClient();
  if (got.length < 32 || !db) return false;
  const r = await db.rpc("autopilot_secret_ok", { token: got });
  return !r.error && r.data === true;
}

export const unauthorized = () => Response.json({ error: "Staff with two-factor only" }, { status: 403 });
