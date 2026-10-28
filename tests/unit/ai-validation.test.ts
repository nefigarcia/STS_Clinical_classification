import { describe, expect, it } from "vitest";
import { validateModelOutput, locateExcerpt, mergeDuplicateEvents } from "@/lib/ai/response-validator";
import { decideEscalation } from "@/lib/ai/model-router";
import { modelOutputSchema, type ModelOutput } from "@/lib/ai/response-schema";
import { computeCost } from "@/lib/ai/cost-tracker";
import { buildUserPrompt } from "@/lib/ai/prompts";
import type { CandidatePassage } from "@/lib/ai/candidate-detection";
import type { RetrievedRule } from "@/lib/ai/sts-rules";
import type { AllowedCode } from "@/lib/sts/code-validator";

// Fixture rules are TEST FIXTURES with made-up codes, not STS content.
const passage = (label: string, noteId: string, text: string, start = 100): CandidatePassage => ({
  label,
  clinicalNoteId: `cn-${noteId}`,
  noteId,
  noteType: "ICU Progress Note",
  dateOfService: "2026-01-06",
  start,
  end: start + text.length,
  text,
  hits: [],
  score: 1,
});
const rule = (label: string, code: string | null, name: string | null, text = "TEST FIXTURE RULE"): RetrievedRule & { label: string } => ({
  id: `rule-${label}`,
  label,
  manualVersion: "TEST",
  sectionName: "Test Section",
  pageNumber: 42,
  longName: "Test field",
  shortName: null,
  stsCode: code,
  complicationName: name,
  chunkText: text,
  score: 1,
});
const allowed = new Map<string, AllowedCode>([["T100", { code: "T100", name: "Test pneumothorax", ruleId: "rule-R1", page: 42, section: "Test Section" }]]);
const passages = [
  passage("P1", "000900002", "POD1. Chest X-ray shows new right pneumothorax; chest tube placed."),
  passage("P2", "000900003", "Second note also documents the pneumothorax requiring chest tube.", 500),
];
const rules = [rule("R1", "T100", "Test pneumothorax")];

const ev = (over: Partial<ModelOutput["events"][number]> = {}): ModelOutput["events"][number] => ({
  complication: "Pneumothorax",
  ruleRef: "R1",
  stsCode: "T100",
  assertion: "confirmed",
  evidenceStatus: "supported",
  eventDate: "2026-01-06",
  evidence: [{ passageRef: "P1", excerpt: "new right pneumothorax; chest tube placed" }],
  explanation: "Documented new pneumothorax requiring chest tube.",
  confidenceScore: 0.8,
  uncertainty: "low",
  ...over,
});
const out = (events: ModelOutput["events"]): ModelOutput => ({ events, needsEscalation: false, escalationReason: null });

describe("response schema", () => {
  it("parses a well-formed model output", () => {
    expect(modelOutputSchema.parse(out([ev()])).events).toHaveLength(1);
  });
});

describe("validateModelOutput", () => {
  const ctx = { passages, rules, allowedCodes: allowed };

  it("verifies excerpts against source text and maps passage labels to real note IDs", () => {
    const r = validateModelOutput(out([ev()]), ctx);
    expect(r.failed).toBe(false);
    const e = r.events[0];
    expect(e.classificationStatus).toBe("SUGGESTED");
    expect(e.reviewStatus).toBe("PENDING"); // never auto-approved
    expect(e.evidence[0]).toMatchObject({ noteId: "000900002", clinicalNoteId: "cn-000900002", verified: true });
    expect(e.evidence[0].start).toBe(100 + passages[0].text.toLowerCase().indexOf("new right"));
    expect(e.rule?.pageNumber).toBe(42);
    expect(e.complication).toBe("Test pneumothorax");
  });

  it("tolerates whitespace/case differences but rejects paraphrase", () => {
    expect(locateExcerpt(passages[0], "NEW RIGHT   pneumothorax")).not.toBeNull();
    expect(locateExcerpt(passages[0], "collapsed lung on the right")).toBeNull();
  });

  it("removes invented STS codes and flags for review", () => {
    const r = validateModelOutput(out([ev({ stsCode: "999" })]), ctx);
    expect(r.events[0].stsCode).toBe("T100"); // falls back to the cited rule's own code
    expect(r.events[0].issues.join()).toMatch(/does not exist in the indexed manual/);
    expect(r.events[0].reviewStatus).toBe("NEEDS_REVIEW");
    expect(r.failed).toBe(true);
  });

  it("rejects unknown passage and rule references (no invented note IDs or manual references)", () => {
    const r = validateModelOutput(out([ev({ ruleRef: "R9", evidence: [{ passageRef: "P99", excerpt: "pneumothorax" }] })]), ctx);
    const e = r.events[0];
    expect(e.rule).toBeNull();
    expect(e.evidence).toHaveLength(0);
    expect(e.classificationStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(e.issues.join()).toMatch(/unknown passage/);
  });

  it("downgrades confirmed events without verifiable evidence (false-positive safeguard)", () => {
    const r = validateModelOutput(out([ev({ evidence: [{ passageRef: "P1", excerpt: "massive tension pneumothorax with arrest" }] })]), ctx);
    expect(r.events[0].classificationStatus).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.events[0].evidence[0].verified).toBe(false);
  });

  it("maps negated/historical/planned assertions to EXCLUDED and suspected to needs review", () => {
    const r = validateModelOutput(
      out([ev({ assertion: "negated" }), ev({ complication: "Other", ruleRef: null, stsCode: null, assertion: "suspected" })]),
      ctx,
    );
    expect(r.events.find((e) => e.assertion === "negated")!.classificationStatus).toBe("EXCLUDED");
    const s = r.events.find((e) => e.assertion === "suspected")!;
    expect(s.classificationStatus).toBe("SUSPECTED");
    expect(s.reviewStatus).toBe("NEEDS_REVIEW");
  });

  it("supports multiple complications per encounter and merges duplicate events across notes", () => {
    const r = validateModelOutput(
      out([
        ev(),
        ev({ evidence: [{ passageRef: "P2", excerpt: "documents the pneumothorax requiring chest tube" }] }),
        ev({ complication: "Chylothorax", ruleRef: null, stsCode: null, eventDate: "2026-01-09", evidence: [{ passageRef: "P2", excerpt: "Second note" }] }),
      ]),
      ctx,
    );
    expect(r.events).toHaveLength(2);
    const ptx = r.events.find((e) => e.complication === "Test pneumothorax")!;
    expect(ptx.evidence.map((x) => x.noteId)).toEqual(["000900002", "000900003"]);
  });

  it("clamps self-reported confidence", () => {
    expect(validateModelOutput(out([ev({ confidenceScore: 7 })]), ctx).events[0].confidenceScore).toBe(1);
  });

  it("mergeDuplicateEvents keeps distinct dates separate", () => {
    const r = validateModelOutput(out([ev(), ev({ eventDate: "2026-01-20" })]), ctx);
    expect(mergeDuplicateEvents(r.events)).toHaveLength(2);
  });
});

describe("decideEscalation", () => {
  const base = {
    highRiskTerms: ["cardiac arrest"],
    forced: false,
    escalationsSoFar: 0,
    processedSoFar: 0,
    maxEscalationRate: 0.25,
    primaryModel: "luna",
    escalationModel: "sol",
  };
  const ctx = { passages, rules, allowedCodes: allowed };
  it("does not escalate clean results", () => {
    const o = out([ev()]);
    expect(decideEscalation({ ...base, output: o, validation: validateModelOutput(o, ctx) }).escalate).toBe(false);
  });
  it("escalates on validation failure, conflict, high-risk labels and reviewer request", () => {
    const failed = out([ev({ stsCode: "999" })]);
    expect(decideEscalation({ ...base, output: failed, validation: validateModelOutput(failed, ctx) }).escalate).toBe(true);
    const risky = out([ev({ complication: "Cardiac arrest", ruleRef: null, stsCode: null })]);
    expect(decideEscalation({ ...base, output: risky, validation: validateModelOutput(risky, ctx) }).reasons.join()).toMatch(/high-risk/);
    const o = out([ev()]);
    expect(decideEscalation({ ...base, forced: true, output: o, validation: validateModelOutput(o, ctx) }).escalate).toBe(true);
  });
  it("respects the escalation-rate cap and never escalates to the same model", () => {
    const failed = out([ev({ stsCode: "999" })]);
    const v = validateModelOutput(failed, ctx);
    expect(decideEscalation({ ...base, output: failed, validation: v, escalationsSoFar: 3, processedSoFar: 4 }).escalate).toBe(false);
    expect(decideEscalation({ ...base, output: failed, validation: v, escalationModel: "luna" }).escalate).toBe(false);
  });
});

describe("cost and prompts", () => {
  it("computes cost only from configured prices", () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000, reasoningTokens: 0 };
    expect(computeCost("m", usage, { m: { inputPer1M: 1, cachedInputPer1M: 0.1, outputPer1M: 4 } })).toBeCloseTo(0.8 + 0.02 + 0.4);
    expect(computeCost("unknown", usage, {})).toBeNull();
  });
  it("never includes patient identifiers in the model prompt", () => {
    const p = buildUserPrompt({ manualVersion: "TEST", surgeryDate: "2026-01-05", passages, rules, examples: [] });
    expect(p).not.toContain("000900002");
    expect(p).not.toContain("cn-");
    expect(p).toContain('label="P1"');
    expect(p).toContain('label="R1"');
  });
});
