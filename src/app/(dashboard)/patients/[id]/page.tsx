import { requirePageRole } from "@/lib/auth/guard";
import { hasRole } from "@/lib/auth/roles";
import { ReviewWorkspace } from "@/components/review/review-workspace";

export const dynamic = "force-dynamic";

export default async function EncounterReviewPage({ params, searchParams }: PageProps<"/patients/[id]">) {
  const user = await requirePageRole("READ_ONLY");
  const { id } = await params;
  const sp = await searchParams;
  const backRaw = Array.isArray(sp.back) ? sp.back[0] : sp.back;
  const back = backRaw && backRaw.startsWith("/") && !backRaw.startsWith("//") ? backRaw : null;
  return <ReviewWorkspace key={id} encounterId={id} canReview={hasRole(user.role, "REVIEWER")} back={back} />;
}
