import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";
import { currentUser } from "@/lib/auth/guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChangePasswordForm } from "./change-password-form";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  if (!user.passwordHash) redirect("/dashboard");
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-6" aria-hidden />
          </div>
          <CardTitle className="text-xl">Change password</CardTitle>
          <CardDescription>{user.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm mustChange={user.mustChangePassword} />
        </CardContent>
      </Card>
    </main>
  );
}
