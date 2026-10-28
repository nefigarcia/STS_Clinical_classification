import type { SourceFile } from "@prisma/client";
import { readStored } from "@/lib/storage";
import { listWorksheets } from "./excel-reader";
import { loadTable } from "./import-service";
import { detectKind, suggestMapping, type ImportKind } from "./column-mapping";

const PREVIEW_ROWS = 15;
const PREVIEW_CHARS = 160;

/** Preview a tabular upload. Long text cells are truncated so full notes are not shown in previews. */
export async function previewUpload(file: SourceFile, sheetName?: string | null) {
  const sheets = file.fileType === "xlsx" ? await listWorksheets(await readStored(file.id)) : ["CSV"];
  const sheet = sheetName && sheets.includes(sheetName) ? sheetName : file.fileType === "xlsx" ? sheets[0] : null;
  const table = await loadTable(file, sheet);
  const kind: ImportKind = file.kind === "HISTORICAL_COMPLICATIONS" ? "HISTORICAL_COMPLICATIONS" : "CLINICAL_NOTES";
  return {
    sheets,
    sheetName: sheet,
    headers: table.headers,
    totalRows: table.rows.length,
    detectedKind: detectKind(table.headers),
    suggestedMapping: suggestMapping(kind, table.headers),
    preview: table.rows
      .slice(0, PREVIEW_ROWS)
      .map((r) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.length > PREVIEW_CHARS ? `${v.slice(0, PREVIEW_CHARS)}… (${v.length} chars)` : v])),
      ),
  };
}
