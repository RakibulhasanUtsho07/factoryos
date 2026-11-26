import { NextResponse, NextRequest } from "next/server";
import { randomToken, pkceChallenge, seal, TX_COOKIE, cookieOptions } from "@/lib/auth0-server.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const tenantId = new URL(request.url).searchParams.get("tenant") ?? "";
  if (!UUID.test(tenantId)) return NextResponse.redirect(
    new URL("/login?error=tenant", process.env.AUTH0_BASE_URL ?? "http://localhost:3000"));

  const state = randomToken(), nonce = randomToken();
  const verifier = randomToken(48);
  const tx = await seal({ state, nonce, verifier, tenantId });

  const url = new URL((process.env.AUTH0_ISSUER_BASE_URL ?? "") + "/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: process.env.AUTH0_CLIENT_ID ?? "",
    redirect_uri: (process.env.AUTH0_BASE_URL ?? "") + "/auth/callback",
    scope: "openid profile email offline_access",
    audience: process.env.AUTH0_AUDIENCE ?? "",
    state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();

  const res = NextResponse.redirect(url);
  res.cookies.set(TX_COOKIE, tx, cookieOptions(10, "/auth") as any);
  return res;
}