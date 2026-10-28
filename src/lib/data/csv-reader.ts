import Papa from "papaparse";
import type { RawTable } from "./excel-reader";

/** Parse CSV keeping every value as a string (dynamicTyping off) so identifiers keep leading zeros. */
export function readCsv(text: string): RawTable {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<Record<string, string>>(clean, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const fatal = result.errors.find((e) => e.type === "Delimiter" || e.code === "MissingQuotes");
  if (fatal) throw new Error(`CSV parse error at row ${fatal.row ?? "?"}: ${fatal.message}`);
  const headers = result.meta.fields ?? [];
  const rows = result.data.map((r) => {
    const rec: Record<string, string> = {};
    for (const h of headers) rec[h] = r[h] ?? "";
    return rec;
  });
  return { sheetName: "CSV", headers, rows };
}
