import { requirePageRole } from "@/lib/auth/guard";
import { hasRole } from "@/lib/auth/roles";
import { PageHeader } from "@/components/common";
import { ValidationDashboard } from "@/components/validation/validation-dashboard";

export default async function ValidationPage() {
  const user = await requirePageRole("READ_ONLY");
  return (
    <>
      <PageHeader
        title="Historical Validation"
        description="Compare AI output with the human-reviewed historical labels (Complications.xlsx), verify example evidence, and compare models on held-out cohorts."
      />
      <ValidationDashboard canReview={hasRole(user.role, "REVIEWER")} isAdmin={hasRole(user.role, "ADMIN")} />
    </>
  );
}
