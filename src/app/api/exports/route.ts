import { NextResponse } from "next/server";
import { handle, requireRole } from "@/lib/auth/guard";
import { searchParams } from "@/lib/api";
import { complicationLevelRows, exportFileName, noteLevelRows, renderExport } from "@/lib/export/exporter";
import { audit } from "@/lib/audit";

export const maxDuration = 120;

/** Download reviewed results. Restricted to reviewers/admins; every export is audited. */
export async function GET(req: Request) {
  return handle("GET /api/exports", async () => {
    const user = await requireRole("REVIEWER");
    const sp = searchParams(req);
    const level = sp.get("level") === "note" ? "note" : "complication";
    const format = sp.get("format") === "xlsx" ? "xlsx" : "csv";
    const statuses = sp.get("status")?.split(",").filter(Boolean);
    const sourceFileId = sp.get("sourceFileId") ?? undefined;
    const rows = level === "note" ? await noteLevelRows({ reviewStatus: statuses, sourceFileId }) : await complicationLevelRows({ reviewStatus: statuses });
    const body = await renderExport(rows, format);
    const name = exportFileName(level, format);
    await audit({
      userId: user.id,
      action: "export.download",
      entityType: "Export",
      entityId: name,
      metadata: { level, format, rows: rows.length, statuses: statuses ?? [] },
    });
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
  });
}
