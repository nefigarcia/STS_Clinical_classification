import { handle, requireRole } from "@/lib/auth/guard";
import { intParam, searchParams } from "@/lib/api";
import { searchEncounters } from "@/lib/patients/search";

export async function GET(req: Request) {
  return handle("GET /api/patients", async () => {
    await requireRole("READ_ONLY");
    const sp = searchParams(req);
    const sort = (["mrn", "csn", "date", "status"] as const).find((s) => s === sp.get("sort")) ?? "mrn";
    return searchEncounters({
      q: sp.get("q") ?? undefined,
      mrn: sp.get("mrn") ?? undefined,
      csn: sp.get("csn") ?? undefined,
      dateOfService: sp.get("dos") ?? undefined,
      noteId: sp.get("noteId") ?? undefined,
      complication: sp.get("complication") ?? undefined,
      reviewStatus: sp.get("status") ?? undefined,
      page: intParam(sp.get("page"), 1, 1, 100_000),
      pageSize: intParam(sp.get("pageSize"), 25, 5, 200),
      sort,
      dir: sp.get("dir") === "desc" ? "desc" : "asc",
    });
  });
}
