import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirect for unauthenticated page visits. Real authorization happens
 * server-side in every layout/page and API route (requireRole); this only improves UX.
 */
export function proxy(req: NextRequest) {
  const hasSession = req.cookies.has("authjs.session-token") || req.cookies.has("__Secure-authjs.session-token");
  if (!hasSession) {
    const url = new URL("/sign-in", req.url);
    url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Pages only: API routes authorize themselves; sign-in and static assets are public.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sign-in).*)"],
};
