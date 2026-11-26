import { NextResponse, NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const session = request.cookies.get("fos_session")?.value;
  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/ai/:path*", "/wms/:path*"],
};