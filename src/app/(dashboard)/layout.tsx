import { redirect } from "next/navigation";
import Link from "next/link";
import { KeyRound, LogOut, ShieldAlert } from "lucide-react";
import { currentUser } from "@/lib/auth/guard";
import { signOut } from "@/lib/auth/auth";
import { systemStatus } from "@/lib/security/gates";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { devLoginAllowed, env } from "@/lib/env";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { Button, buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  if (user.mustChangePassword) redirect("/change-password");
  const status = await systemStatus();
  const warnings: string[] = [];
  if (!status.approvedManual) warnings.push("STS-based classification unavailable: no approved STS CHSD Training Manual is loaded.");
  if (!status.openaiConfigured) warnings.push("OpenAI is not configured; AI processing is disabled.");
  if (!status.phiExternalAiApproved) warnings.push("PHI external-AI approval is OFF: only SYNTHETIC datasets can be sent to OpenAI.");

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-r bg-white lg:block">
        <AppSidebar role={user.role} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b bg-white/90 px-4 backdrop-blur lg:px-6">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {devLoginAllowed() && <span className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-900">{env().AUTH_DEV_LOGIN_UNSAFE_OVERRIDE ? "PILOT: password-less login enabled" : "DEV LOGIN · synthetic data only"}</span>}
            <span className="hidden sm:inline">Environment: {status.appEnv}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right leading-tight">
              <div className="text-sm font-medium">{user.name ?? user.email}</div>
              <div className="text-[11px] text-muted-foreground">{ROLE_LABEL[user.role]}</div>
            </div>
            {user.passwordHash && (
              <Link href="/change-password" className={buttonVariants({ variant: "ghost", size: "icon" })} aria-label="Change password" title="Change password">
                <KeyRound aria-hidden />
              </Link>
            )}
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/sign-in" });
              }}
            >
              <Button variant="ghost" size="icon" type="submit" aria-label="Sign out">
                <LogOut aria-hidden />
              </Button>
            </form>
          </div>
        </header>
        {warnings.length > 0 && (
          <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 lg:px-6">
            {warnings.map((w) => (
              <p key={w} className="flex items-center gap-2">
                <ShieldAlert className="size-3.5 shrink-0" aria-hidden /> {w}
              </p>
            ))}
          </div>
        )}
        <nav aria-label="Mobile" className="overflow-x-auto border-b bg-white lg:hidden">
          <div className="min-w-max">
            <AppSidebar role={user.role} />
          </div>
        </nav>
        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
