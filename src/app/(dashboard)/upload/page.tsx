import { requirePageRole } from "@/lib/auth/guard";
import { PageHeader } from "@/components/common";
import { UploadWizard } from "@/components/upload/upload-wizard";

export default async function UploadPage() {
  await requirePageRole("REVIEWER");
  return (
    <>
      <PageHeader
        title="Upload Data"
        description="Import clinical notes or historical expected complications. Files are validated and you review the import report before anything is saved."
      />
      <UploadWizard />
    </>
  );
}
