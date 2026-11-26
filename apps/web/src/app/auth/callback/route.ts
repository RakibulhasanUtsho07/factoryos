import { NextResponse, NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { unseal, seal, verifyIdToken, TX_COOKIE, SESSION_COOKIE, cookieOptions } from "@/lib/auth0-server.mjs";

function fail(code: string) {
  const res = NextResponse.redirect(
    new URL("/login?error=" + code, process.env.AUTH0_BASE_URL ?? "http://localhost:3000"));
  res.cookies.delete(TX_COOKIE);
  return res;
}

function same(a: string | null, b: string | undefined) {
  const x = Buffer.from(a ?? ""), y = Buffer.from(b ?? "");
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const sealed = request.cookies.get(TX_COOKIE)?.value;
  if (!code || !sealed) return fail("callback");

  let tx: any;
  try { tx = await unseal(sealed); } catch { return fail("callback"); }
  if (!same(state, tx.state)) return fail("state");

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", (process.env.AUTH0_BASE_URL ?? "") + "/auth/callback");
  body.set("client_id", process.env.AUTH0_CLIENT_ID ?? "");
  body.set("client_secret", process.env.AUTH0_CLIENT_SECRET ?? "");
  body.set("code_verifier", tx.verifier);

  const tokenRes = await fetch((process.env.AUTH0_ISSUER_BASE_URL ?? "") + "/oauth/token",
    { method: "POST", body, cache: "no-store",
      headers: { "content-type": "application/x-www-form-urlencoded" } });
  if (!tokenRes.ok) return fail("exchange");
  const tokens = await tokenRes.json();
  if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token)
    return fail("exchange");

  let claims: any;
  try { claims = await verifyIdToken(tokens.id_token, tx.nonce); }
  catch { return fail("verify"); }

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  const session = await seal({ accessToken, refreshToken,
    idToken: tokens.id_token, tenantId: tx.tenantId, sub: claims.sub,
    expiresAt: Date.now() + tokens.expires_in * 1000 });

  const res = NextResponse.redirect(new URL("/", process.env.AUTH0_BASE_URL ?? "http://localhost:3000"));
  res.cookies.delete(TX_COOKIE);
  res.cookies.set(SESSION_COOKIE, session, cookieOptions(480, "/") as any);
  return res;
}