import { createHash } from "node:crypto";

const NULL_TOKENS = new Set(["", "null", "nul", "n/a", "na", "none", "#n/a", "undefined"]);

export function isNullToken(v: string | null | undefined): boolean {
  return v === null || v === undefined || NULL_TOKENS.has(v.trim().toLowerCase());
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export type IdResult = { value: string | null; issue?: string };

/**
 * Normalize an identifier while preserving it exactly (leading zeros, letters).
 * Only surrounding whitespace is trimmed; a spreadsheet float artefact like
 * "1234567.0" is reported but NOT silently rewritten.
 */
export function normalizeIdentifier(raw: string | null | undefined, field: string): IdResult {
  if (isNullToken(raw)) return { value: null, issue: `${field} is missing` };
  const v = raw!.trim();
  if (/\s/.test(v)) return { value: v, issue: `${field} contains internal whitespace` };
  if (/^\d+\.\d+$/.test(v)) return { value: v, issue: `${field} looks like a decimal number (possible spreadsheet conversion)` };
  if (/[eE]\+\d+$/.test(v)) return { value: v, issue: `${field} is in scientific notation; precision may have been lost upstream` };
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return { value: v, issue: `${field} contains unexpected characters` };
  return { value: v };
}

export type DateResult = { date: Date | null; iso: string | null; raw: string; issue?: string };

const pad = (n: number) => String(n).padStart(2, "0");

function build(y: number, m: number, d: number, hh = 0, mi = 0, ss = 0): Date | null {
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mi, ss));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || y > 2100) return null;
  return dt;
}

/**
 * Parse common EHR export date formats into a wall-clock Date stored as UTC
 * (no timezone conversion). Accepts ISO, M/D/YYYY [h:mm[:ss] [AM|PM]] and Excel serials.
 */
export function normalizeDate(raw: string | null | undefined): DateResult {
  const r = (raw ?? "").trim();
  if (isNullToken(r)) return { date: null, iso: null, raw: r, issue: "date is missing" };
  let m = r.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?)?$/);
  let dt: Date | null = null;
  if (m) dt = build(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  if (!dt && (m = r.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/))) {
    let year = +m[3];
    if (m[3].length === 2) year += year >= 70 ? 1900 : 2000;
    let hh = +(m[4] ?? 0);
    const ap = m[7]?.toUpperCase();
    if (ap === "PM" && hh < 12) hh += 12;
    if (ap === "AM" && hh === 12) hh = 0;
    dt = build(year, +m[1], +m[2], hh, +(m[5] ?? 0), +(m[6] ?? 0));
  }
  if (!dt && /^\d{5}(\.\d+)?$/.test(r)) {
    const serial = parseFloat(r);
    if (serial > 20000 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 86400 * 1000);
      dt = new Date(ms);
    }
  }
  if (!dt) return { date: null, iso: null, raw: r, issue: `unrecognized date format` };
  const hasTime = dt.getUTCHours() || dt.getUTCMinutes() || dt.getUTCSeconds();
  const iso = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}${
    hasTime ? `T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}` : ""
  }`;
  return { date: dt, iso, raw: r };
}

export function dateKey(d: Date | null | undefined): string | null {
  if (!d) return null;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function cleanText(v: string | null | undefined): string | null {
  return isNullToken(v) ? null : v!.trim();
}
