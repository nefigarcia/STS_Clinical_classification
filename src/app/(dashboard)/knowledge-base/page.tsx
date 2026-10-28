import { Suspense } from "react";
import { requirePageRole } from "@/lib/auth/guard";
import { hasRole } from "@/lib/auth/roles";
import { PageHeader } from "@/components/common";
import { KnowledgeBase } from "@/components/knowledge-base/knowledge-base";

export default async function KnowledgeBasePage() {
  const user = await requirePageRole("READ_ONLY");
  return (
    <>
      <PageHeader
        title="STS Knowledge Base"
        description="Indexed STS CHSD Training Manual versions. The manual's rules take priority over similarity to historical records."
      />
      <Suspense>
        <KnowledgeBase isAdmin={hasRole(user.role, "ADMIN")} />
      </Suspense>
    </>
  );
}
