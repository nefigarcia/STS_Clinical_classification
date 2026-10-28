import ExcelJS from "exceljs";

export type RawTable = {
  sheetName: string;
  headers: string[];
  rows: Record<string, string>[];
};

/** Format a JS Date (as produced by ExcelJS: wall-clock time encoded as UTC) to ISO without TZ shift. */
export function excelDateToIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hasTime = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds();
  return hasTime ? `${date}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : date;
}

/**
 * Convert any ExcelJS cell value to a string while preserving identifier text exactly.
 * Numbers are rendered without exponent/rounding where possible; zero-padded number
 * formats (e.g. "0000000") are honored so leading zeros survive.
 */
export function cellToString(value: ExcelJS.CellValue, numFmt?: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    let s = Number.isInteger(value) ? BigInt(value).toString() : String(value);
    if (numFmt && /^0+$/.test(numFmt) && s.length < numFmt.length) s = s.padStart(numFmt.length, "0");
    return s;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return excelDateToIso(value);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join("");
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return cellToString(value.result as ExcelJS.CellValue, numFmt);
    if ("error" in value) return "";
  }
  return String(value);
}

export async function listWorksheets(buffer: ArrayBuffer | Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);
  return wb.worksheets.map((w) => w.name);
}

export async function readExcel(buffer: ArrayBuffer | Buffer, sheetName?: string): Promise<RawTable> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as ArrayBuffer);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new Error(`Worksheet "${sheetName}" not found`);
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, col) => {
    headers[col - 1] = cellToString(c.value).trim();
  });
  for (let i = 0; i < headers.length; i++) if (!headers[i]) headers[i] = `Column${i + 1}`;
  const rows: Record<string, string>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      const cell = row.getCell(i + 1);
      rec[h] = cellToString(cell.value, cell.numFmt);
    });
    if (Object.values(rec).some((v) => v.trim() !== "")) rows.push(rec);
  });
  return { sheetName: ws.name, headers, rows };
}
