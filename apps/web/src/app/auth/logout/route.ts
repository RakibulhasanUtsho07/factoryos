import { NextResponse } from "next/server";
import { SESSION_COOKIE, TX_COOKIE } from "@/lib/auth0-server.mjs";

export async function GET() {
  const url = new URL((process.env.AUTH0_ISSUER_BASE_URL ?? "") + "/v2/logout");
  url.search = new URLSearchParams({
    client_id: process.env.AUTH0_CLIENT_ID ?? "",
    returnTo: (process.env.AUTH0_BASE_URL ?? "") + "/login",
  }).toString();

  const res = NextResponse.redirect(url);
  res.cookies.delete(SESSION_COOKIE);
  res.cookies.delete(TX_COOKIE);
  return res;
}