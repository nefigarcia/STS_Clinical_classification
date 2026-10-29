"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, KeyRound } from "lucide-react";
import { api } from "@/lib/client/fetch";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signOutAfterPasswordChange } from "./actions";

export function ChangePasswordForm({ mustChange }: { mustChange: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api("/api/account/password", {
        method: "POST",
        json: { current: fd.get("current"), next: fd.get("next"), confirm: fd.get("confirm") },
      });
      await signOutAfterPasswordChange();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {mustChange && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          You signed in with a temporary password. Choose your own password to continue.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="current">{mustChange ? "Temporary password" : "Current password"}</Label>
        <Input id="current" name="current" type="password" autoComplete="current-password" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="next">New password</Label>
        <Input id="next" name="next" type="password" autoComplete="new-password" required minLength={12} aria-describedby="pw-rules" />
        <p id="pw-rules" className="text-xs text-muted-foreground">
          At least 12 characters, with three of: lowercase, uppercase, digits, symbols. Avoid common words and your email name.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />} Change password
      </Button>
      {!mustChange && (
        <Link href="/dashboard" className={buttonVariants({ variant: "ghost", className: "w-full" })}>
          Cancel
        </Link>
      )}
      <p className="text-center text-xs text-muted-foreground">You will be signed out everywhere and asked to sign in with the new password.</p>
    </form>
  );
}
