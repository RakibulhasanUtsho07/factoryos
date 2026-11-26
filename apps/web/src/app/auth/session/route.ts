import { NextResponse, NextRequest } from "next/server";
import { unseal, seal, SESSION_COOKIE, cookieOptions } from "@/lib/auth0-server.mjs";

export async function GET(request: NextRequest) {
  const sealed = request.cookies.get(SESSION_COOKIE)?.value;
  if (!sealed) return NextResponse.json({ error: "no session" }, { status: 401 });

  let s: any;
  try { s = await unseal(sealed); } catch {
    return NextResponse.json({ error: "bad session" }, { status: 401 });
  }

  if (s.expiresAt - Date.now() > 60_000) {
    const accessToken = s.accessToken;
    return NextResponse.json({ accessToken, tenantId: s.tenantId });
  }

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", s.refreshToken);
  body.set("client_id", process.env.AUTH0_CLIENT_ID ?? "");
  body.set("client_secret", process.env.AUTH0_CLIENT_SECRET ?? "");

  const r = await fetch((process.env.AUTH0_ISSUER_BASE_URL ?? "") + "/oauth/token",
    { method: "POST", body, cache: "no-store",
      headers: { "content-type": "application/x-www-form-urlencoded" } });
  if (!r.ok) {
    const res = NextResponse.json({ error: "expired" }, { status: 401 });
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  const t = await r.json();
  const accessToken = t.access_token;
  const refreshToken = t.refresh_token ?? s.refreshToken;
  s = { ...s, accessToken, refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000 };

  const res = NextResponse.json({ accessToken, tenantId: s.tenantId });
  res.cookies.set(SESSION_COOKIE, await seal(s), cookieOptions(480, "/") as any);
  return res;
}