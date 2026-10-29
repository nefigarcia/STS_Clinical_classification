import { redirect, unstable_rethrow } from "next/navigation";
import { log } from "@/lib/security/logger";
import { HeartPulse, ShieldAlert, LogIn } from "lucide-react";
import { signIn } from "@/lib/auth/auth";
import { currentUser } from "@/lib/auth/guard";
import { devLoginAllowed, entraConfigured, passwordLoginEnabled } from "@/lib/env";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

/**
 * Auth.js errors carry a stable `type`; class names are minified in production builds.
 * A Prisma code from the wrapped cause (e.g. P1001 = DB unreachable) is appended; it is generic, never data.
 */
function authErrorType(err: unknown): string {
  const e = err as { type?: unknown; cause?: { err?: { code?: unknown; errorCode?: unknown } } } | null;
  const type = typeof e?.type === "string" ? e.type : "SignInError";
  const code = e?.cause?.err?.code ?? e?.cause?.err?.errorCode;
  return typeof code === "string" && /^P\d{4}$/.test(code) ? `${type}: ${code}` : type;
}

function safeCallback(v: string | string[] | undefined) {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.startsWith("/") && !s.startsWith("//") ? s : "/dashboard";
}

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const sp = await searchParams;
  const callbackUrl = safeCallback(sp.callbackUrl);
  if (await currentUser()) redirect(callbackUrl);
  const entra = entraConfigured();
  const dev = devLoginAllowed();
  const password = passwordLoginEnabled();
  const credentialsError = sp.error === "credentials";
  const notice = Array.isArray(sp.notice) ? sp.notice[0] : sp.notice;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <HeartPulse className="size-6" aria-hidden />
          </div>
          <CardTitle className="text-xl">STS Complication Review</CardTitle>
          <CardDescription>Children&apos;s Nebraska · Clinical abstraction platform</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {notice === "password-changed" && (
            <p role="status" className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
              Password changed. Please sign in with your new password.
            </p>
          )}
          {credentialsError && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              Invalid email or password, or the account is locked or disabled. After 5 failed attempts an account is locked for 15 minutes; an administrator can
              unlock it.
            </p>
          )}
          {sp.error && !credentialsError && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              Sign-in failed ({String(sp.error)}). Your account may not be authorized, or the server could not complete sign-in.
            </p>
          )}
          {password && (
            <form
              className="space-y-3"
              action={async (fd: FormData) => {
                "use server";
                try {
                  await signIn("password", { email: String(fd.get("email") ?? ""), password: String(fd.get("password") ?? ""), redirectTo: callbackUrl });
                } catch (err) {
                  unstable_rethrow(err); // success is a redirect
                  const type = (err as { type?: string } | null)?.type;
                  redirect(`/sign-in?error=${type === "CredentialsSignin" ? "credentials" : encodeURIComponent(authErrorType(err))}`);
                }
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="email">Work email</Label>
                <Input id="email" name="email" type="email" autoComplete="username" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input id="password" name="password" type="password" autoComplete="current-password" required />
              </div>
              <Button type="submit" className="w-full" size="lg">
                <LogIn aria-hidden /> Sign in
              </Button>
              <p className="text-center text-xs text-muted-foreground">Forgot your password? Ask an administrator to reset it.</p>
            </form>
          )}
          {password && entra && <div className="text-center text-xs text-muted-foreground">or</div>}
          {entra && (
            <form
              action={async () => {
                "use server";
                await signIn("microsoft-entra-id", { redirectTo: callbackUrl });
              }}
            >
              <Button type="submit" className="w-full" size="lg">
                <LogIn aria-hidden /> Sign in with Microsoft
              </Button>
            </form>
          )}
          {!entra && !dev && !password && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Microsoft Entra ID is not configured. Set AUTH_MICROSOFT_ENTRA_ID_ID, _SECRET and _ISSUER, or enable AUTH_DEV_LOGIN_ENABLED for local
              synthetic-data development.
            </p>
          )}
          {dev && (
            <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="flex items-start gap-2 text-sm text-amber-900">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                Development sign-in. For local work with synthetic data only. Disabled in production and when PHI processing is approved.
              </p>
              <form
                className="grid grid-cols-3 gap-2"
                action={async (fd: FormData) => {
                  "use server";
                  try {
                    await signIn("dev-login", { role: String(fd.get("role")), redirectTo: callbackUrl });
                  } catch (err) {
                    unstable_rethrow(err); // signIn succeeds by throwing a redirect
                    log.error("dev-login sign-in failed", err, { route: "/sign-in" });
                    redirect(`/sign-in?error=${encodeURIComponent(authErrorType(err))}`);
                  }
                }}
              >
                {(["ADMIN", "REVIEWER", "READ_ONLY"] as const).map((r) => (
                  <Button key={r} type="submit" name="role" value={r} variant="outline" size="sm">
                    {r === "READ_ONLY" ? "Read-only" : r === "ADMIN" ? "Admin" : "Reviewer"}
                  </Button>
                ))}
              </form>
            </div>
          )}
          <p className="text-center text-xs text-muted-foreground">
            Access is restricted to authorized Children&apos;s Nebraska personnel. Activity is audited.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
