/**
 * Structural inspection of local reference spreadsheets.
 *
 * PHI-safe by design: prints sheet names, headers, row counts, identifier
 * *format* statistics (length / digit-only / leading zeros) and the
 * de-identified complication label distribution. It never prints MRN, CSN,
 * NOTE_ID values or note text, and it never sends anything over the network.
 *
 * Usage: npx tsx scripts/inspect-reference-files.ts [dir=reference-data]
 */
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { cellToString } from "../src/lib/data/excel-reader";

const dir = process.argv[2] ?? "reference-data";

function idFormat(values: string[]) {
  const nonEmpty = values.filter((v) => v.length > 0);
  const lengths = new Map<number, number>();
  let digitsOnly = 0;
  let leadingZero = 0;
  for (const v of nonEmpty) {
    lengths.set(v.length, (lengths.get(v.length) ?? 0) + 1);
    if (/^\d+$/.test(v)) digitsOnly++;
    if (/^0\d/.test(v)) leadingZero++;
  }
  return {
    present: nonEmpty.length,
    blank: values.length - nonEmpty.length,
    distinct: new Set(nonEmpty).size,
    digitsOnly,
    leadingZero,
    lengths: Object.fromEntries([...lengths.entries()].sort((a, b) => a[0] - b[0])),
  };
}

async function inspect(file: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  console.log(`\n=== ${path.basename(file)} ===`);
  for (const ws of wb.worksheets) {
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (c, col) => {
      headers[col - 1] = cellToString(c.value).trim();
    });
    const rows: Record<string, string>[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const rec: Record<string, string> = {};
      headers.forEach((h, i) => (rec[h] = cellToString(row.getCell(i + 1).value).trim()));
      if (Object.values(rec).some((v) => v)) rows.push(rec);
    });
    console.log(`Worksheet "${ws.name}": ${rows.length} data rows`);
    console.log(`Headers: ${JSON.stringify(headers)}`);
    const cellTypes: Record<string, Record<string, number>> = {};
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      headers.forEach((h, i) => {
        const v = row.getCell(i + 1).value;
        const t = v === null || v === undefined ? "empty" : v instanceof Date ? "date" : typeof v === "object" ? "object" : typeof v;
        cellTypes[h] ??= {};
        cellTypes[h][t] = (cellTypes[h][t] ?? 0) + 1;
      });
    });
    console.log("Excel cell types per column:", JSON.stringify(cellTypes));
    for (const idCol of ["MRN", "CSN", "NOTE_ID", "PAT_ID"]) {
      if (headers.includes(idCol)) console.log(`${idCol} format:`, JSON.stringify(idFormat(rows.map((r) => r[idCol] ?? ""))));
    }
    if (headers.includes("Complication")) {
      const dist: Record<string, number> = {};
      for (const r of rows) dist[r.Complication || "(blank)"] = (dist[r.Complication || "(blank)"] ?? 0) + 1;
      console.log("Complication label distribution:", JSON.stringify(dist));
    }
    if (headers.includes("NOTE_TYPE")) {
      const dist: Record<string, number> = {};
      for (const r of rows) dist[r.NOTE_TYPE || "(blank)"] = (dist[r.NOTE_TYPE || "(blank)"] ?? 0) + 1;
      console.log("NOTE_TYPE distribution:", JSON.stringify(dist));
    }
    if (headers.includes("COMBINED_NOTE_TEXT")) {
      const lens = rows.map((r) => (r.COMBINED_NOTE_TEXT ?? "").length).sort((a, b) => a - b);
      console.log(
        "Note length chars: min/median/max/blank =",
        lens[0],
        lens[Math.floor(lens.length / 2)],
        lens[lens.length - 1],
        lens.filter((l) => l === 0).length,
      );
    }
    if (headers.includes("Flag Notes")) {
      console.log("Flag Notes populated rows:", rows.filter((r) => r["Flag Notes"]).length);
    }
  }
}

async function main() {
  if (!fs.existsSync(dir)) {
    console.error(`Directory ${dir} not found`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir);
  for (const f of files.filter((f) => /\.xlsx$/i.test(f))) await inspect(path.join(dir, f));
  const pdfs = files.filter((f) => /\.pdf$/i.test(f));
  console.log(`\nPDF files present: ${pdfs.length ? pdfs.join(", ") : "none (STS manual not loaded)"}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
