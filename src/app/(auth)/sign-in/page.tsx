import { redirect } from "next/navigation";
import { HeartPulse, ShieldAlert, LogIn } from "lucide-react";
import { signIn } from "@/lib/auth/auth";
import { currentUser } from "@/lib/auth/guard";
import { devLoginAllowed, entraConfigured } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

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
          {sp.error && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              Sign-in failed. Your account may not be authorized.
            </p>
          )}
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
          {!entra && !dev && (
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
                  await signIn("dev-login", { role: String(fd.get("role")), redirectTo: callbackUrl });
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
