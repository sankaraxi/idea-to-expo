import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic redirect for signed-out users (cookie present?). This is only a
 * convenience: real authentication happens in the layouts / server actions
 * (lib/auth/session.ts), which validate the session against the database.
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isProtected = path.startsWith("/admin") || path.startsWith("/evaluator");
  if (isProtected && !request.cookies.has("ite_session")) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/|templates/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|csv)$).*)"],
};
