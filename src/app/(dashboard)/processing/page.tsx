import { requirePageRole } from "@/lib/auth/guard";
import { hasRole } from "@/lib/auth/roles";
import { classificationGate } from "@/lib/security/gates";
import { PageHeader } from "@/components/common";
import { ProcessingConsole } from "@/components/processing/processing-console";

export const dynamic = "force-dynamic";

export default async function ProcessingPage() {
  const user = await requirePageRole("READ_ONLY");
  // Show the gate for synthetic data; non-synthetic datasets are additionally checked server-side per job.
  const gate = await classificationGate("SYNTHETIC");
  const reasons = [...gate.reasons];
  if (!hasRole(user.role, "REVIEWER")) reasons.push("Starting jobs requires the Clinical Reviewer role.");
  return (
    <>
      <PageHeader
        title="AI Processing"
        description="Background classification jobs. Progress, token usage and cost update live. Interrupted jobs can be resumed."
      />
      <ProcessingConsole canRun={gate.allowed && hasRole(user.role, "REVIEWER")} gateReasons={reasons} />
    </>
  );
}
