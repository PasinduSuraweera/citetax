/**
 * Hands the browser a short lived bearer token for the Citetax API.
 *
 * The NextAuth session cookie is httpOnly and encrypted, so client components
 * cannot read it. This endpoint exchanges the cookie for an HS256 token the
 * Python API can verify. It expires in an hour and carries only identity, never
 * a role.
 */

import { NextResponse } from "next/server";
import { apiToken } from "@/auth";

export async function GET() {
  try {
    const token = await apiToken();
    if (!token) {
      // Signed out is a normal state, not an error: anonymous use is a
      // supported tier. Returning 200 with a null token keeps the browser
      // console clean so real failures stay visible.
      return NextResponse.json(
        { token: null },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { token },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Auth is not configured on this server" },
      { status: 500 },
    );
  }
}
