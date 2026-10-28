import { z } from "zod";

/**
 * Model-facing structured output. The model references passages ("P3") and rules ("R2")
 * by label only; the backend resolves labels to real NOTE_IDs, STS codes and pages.
 * All fields are required (nullable where optional) for strict structured outputs.
 */
export const modelEventSchema = z.object({
  complication: z.string().describe("Complication name exactly as written in the referenced STS rule"),
  ruleRef: z.string().nullable().describe("Label of the STS rule (e.g. R2) that defines this complication, or null"),
  stsCode: z.string().nullable().describe("STS code copied verbatim from the referenced rule text, or null if not present there"),
  assertion: z.enum(["confirmed", "suspected", "negated", "historical", "planned", "outside_window", "insufficient"]),
  evidenceStatus: z.enum(["supported", "insufficient", "conflicting"]),
  eventDate: z.string().nullable().describe("YYYY-MM-DD if documented, else null"),
  evidence: z.array(
    z.object({
      passageRef: z.string().describe("Passage label, e.g. P4"),
      excerpt: z.string().describe("Verbatim quote copied from that passage (max ~300 characters)"),
    }),
  ),
  explanation: z.string().describe("1-3 sentences tying evidence to the STS definition"),
  confidenceScore: z.number().nullable().describe("0-1 self-reported, uncalibrated"),
  uncertainty: z.enum(["low", "medium", "high"]),
});

export const modelOutputSchema = z.object({
  events: z.array(modelEventSchema),
  needsEscalation: z.boolean(),
  escalationReason: z.string().nullable(),
});

export type ModelEvent = z.infer<typeof modelEventSchema>;
export type ModelOutput = z.infer<typeof modelOutputSchema>;

/** Public result shape (spec §9), produced by the backend after validation. */
export type ClinicalClassification = {
  mrn: string;
  csn: string;
  dateOfService: string;
  complications: Array<{
    complication: string;
    stsCode: string | null;
    eventDate: string | null;
    evidenceStatus: "supported" | "insufficient" | "conflicting";
    supportingNoteIds: string[];
    evidence: Array<{ noteId: string; excerpt: string }>;
    manualReference: { version: string; section: string | null; page: number | null };
    explanation: string;
    confidenceScore: number | null;
    reviewStatus: "pending" | "approved" | "rejected" | "needs_review";
  }>;
};
