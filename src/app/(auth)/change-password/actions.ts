"use server";

import { signOut } from "@/lib/auth/auth";

/** After a password change all sessions are invalid; clear this one and return to sign-in. */
export async function signOutAfterPasswordChange() {
  await signOut({ redirectTo: "/sign-in?notice=password-changed" });
}
