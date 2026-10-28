import { requirePageRole } from "@/lib/auth/guard";
import { hasRole } from "@/lib/auth/roles";
import { PageHeader } from "@/components/common";
import { SettingsPanel } from "@/components/settings/settings-panel";

export default async function SettingsPage() {
  const user = await requirePageRole("REVIEWER");
  return (
    <>
      <PageHeader
        title="Settings"
        description="Safety gates, models, cost controls, retrieval, evaluation label mapping, users, versioning and audit. Only administrators can change these settings."
      />
      <SettingsPanel isAdmin={hasRole(user.role, "ADMIN")} />
    </>
  );
}
