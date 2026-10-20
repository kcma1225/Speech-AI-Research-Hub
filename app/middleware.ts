import { NextRequest, NextResponse } from "next/server";
import { crossOrigin } from "@/lib/origin";

export function middleware(request: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return NextResponse.next();
  return crossOrigin(request) ?? NextResponse.next();
}

// Large uploads skip middleware: Next clones middleware bodies and truncates them at 10 MB.
// Those routes call crossOrigin() themselves.
export const config = { matcher: ["/api/((?!items/[^/]+/media$|slides$|slides/[^/]+/versions$|slides/[^/]+/references$).*)"] };
