import { Suspense } from "react";
import { requirePageRole } from "@/lib/auth/guard";
import { PageHeader } from "@/components/common";
import { PatientSearch } from "@/components/patients/patient-search";

export default async function PatientsPage() {
  await requirePageRole("READ_ONLY");
  return (
    <>
      <PageHeader
        title="Patient Search"
        description="Find encounters by MRN, CSN, Date of Service, NOTE_ID, complication or review status. Clinical note text is shown only in the review screen."
      />
      <Suspense>
        <PatientSearch />
      </Suspense>
    </>
  );
}
