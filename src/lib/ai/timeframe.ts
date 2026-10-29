import type { TimeframeClasses } from "@/lib/sts/criteria";

/**
 * Deterministic STS postoperative-event timeframe engine (CHSD TM "General Information
 * Timeframe for Postoperative Events"). Computed in code, never left to the model.
 *
 *  - Intraoperative: OR entry → OR exit (day of the index operation).
 *  - Other postop: after OR exit → the LATER of postoperative day 30 or hospital discharge.
 *  - Major: after OR exit → the LATER of day 30, hospital discharge, or database discharge
 *    (end of the episode of care).
 *  - Events before the index operation are never postoperative events.
 *
 * Granularity is the calendar day (notes carry dates; event clock times are rarely reliable).
 */

export type EncounterDates = {
  surgeryDate: Date | null; // index operation date
  orExitAt: Date | null;
  hospitalDischargeDate: Date | null;
  databaseDischargeDate: Date | null;
};

export type TimeWindow = {
  start: Date | null;
  end: Date | null;
  /** True when the end could be shorter than the real window because a discharge date is unknown. */
  endProvisional: boolean;
  basis: string;
};

export type TimeframeStatus = "in_window" | "before_window" | "after_window" | "unverifiable";

const DAY = 86_400_000;
const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function computeWindow(tf: TimeframeClasses, d: EncounterDates): TimeWindow {
  if (!d.surgeryDate) return { start: null, end: null, endProvisional: true, basis: "Index operation date unknown" };
  const surgery = day(d.surgeryDate);
  const orExit = d.orExitAt ? day(d.orExitAt) : surgery;
  const day30 = surgery + 30 * DAY;
  const parts: string[] = [];
  let end = Number.NEGATIVE_INFINITY;
  let provisional = false;

  if (tf.intraoperative) {
    end = Math.max(end, orExit);
    parts.push(`intraoperative (${iso(surgery)}${d.orExitAt ? ` → OR exit ${iso(orExit)}` : ""})`);
  }
  if (tf.other || tf.major || (!tf.intraoperative && !tf.other && !tf.major)) {
    const hosp = d.hospitalDischargeDate ? day(d.hospitalDischargeDate) : null;
    let e = Math.max(day30, hosp ?? day30);
    let basis = `later of POD 30 (${iso(day30)})${hosp !== null ? ` and hospital discharge (${iso(hosp)})` : " and hospital discharge (unknown)"}`;
    if (hosp === null) provisional = true;
    if (tf.major) {
      const db = d.databaseDischargeDate ? day(d.databaseDischargeDate) : null;
      if (db !== null) e = Math.max(e, db);
      else provisional = true;
      basis = `major: ${basis}${db !== null ? `, database discharge (${iso(db)})` : ", database discharge (unknown)"}`;
    }
    end = Math.max(end, e);
    parts.push(basis);
  }
  // Intraoperative events may start on the operation day; postoperative events after OR exit (same-day allowed).
  const start = tf.intraoperative ? surgery : orExit;
  return { start: new Date(start), end: new Date(end), endProvisional: provisional, basis: parts.join("; ") };
}

export function checkEventDate(eventDate: Date | null, w: TimeWindow): TimeframeStatus {
  if (!eventDate || !w.start || !w.end) return "unverifiable";
  const t = day(eventDate);
  if (t < w.start.getTime()) return "before_window";
  if (t > w.end.getTime()) return w.endProvisional ? "unverifiable" : "after_window";
  return "in_window";
}
