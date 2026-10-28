import { Suspense } from "react";
import { Download } from "lucide-react";
import { requirePageRole } from "@/lib/auth/guard";
import { hasRole } from "@/lib/auth/roles";
import { PageHeader } from "@/components/common";
import { PatientSearch } from "@/components/patients/patient-search";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";

export default async function ReviewQueuePage() {
  const user = await requirePageRole("READ_ONLY");
  const canExport = hasRole(user.role, "REVIEWER");
  return (
    <>
      <PageHeader
        title="Complication Review"
        description="Encounters with AI suggestions awaiting clinical review. Open an encounter to approve, reject or correct each suggestion independently."
      />
      <Suspense>
        <PatientSearch defaultStatus="PENDING" />
      </Suspense>
      {canExport && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Export results</CardTitle>
            <CardDescription>
              Files are named OutputComplication_YYYYMMDD_HHMMSS. Final approved complications are in their own column, separate from unreviewed AI suggestions.
              Save exports only to approved storage locations. Every export is audited.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {[
              ["Complication-level CSV", "/api/exports?level=complication&format=csv"],
              ["Complication-level Excel", "/api/exports?level=complication&format=xlsx"],
              ["Approved only (CSV)", "/api/exports?level=complication&format=csv&status=APPROVED,CORRECTED"],
              ["Note-level CSV (original rows)", "/api/exports?level=note&format=csv"],
              ["Note-level Excel", "/api/exports?level=note&format=xlsx"],
            ].map(([label, href]) => (
              <a key={href} href={href} className={buttonVariants({ variant: "outline" })}>
                <Download aria-hidden /> {label}
              </a>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
