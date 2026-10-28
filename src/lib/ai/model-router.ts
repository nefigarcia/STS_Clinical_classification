import type { ValidationSummary } from "./response-validator";
import type { ModelOutput } from "./response-schema";

export type EscalationDecision = { escalate: boolean; reasons: string[] };

/**
 * Decide whether to re-run an encounter on the escalation model. A larger model is
 * not assumed to fix low confidence by itself; escalation is reserved for conflict,
 * complexity, validation failure, high-risk labels, or an explicit reviewer request.
 */
export function decideEscalation(input: {
  output: ModelOutput;
  validation: ValidationSummary;
  highRiskTerms: string[];
  forced: boolean;
  escalationsSoFar: number;
  processedSoFar: number;
  maxEscalationRate: number;
  primaryModel: string;
  escalationModel: string;
}): EscalationDecision {
  const reasons: string[] = [];
  if (input.forced) reasons.push("reviewer requested second evaluation");
  if (input.validation.failed) reasons.push("initial result failed validation");
  const active = input.validation.events.filter((e) => e.classificationStatus !== "EXCLUDED");
  if (active.some((e) => e.evidenceStatus === "conflicting")) reasons.push("conflicting evidence");
  if (active.length >= 3) reasons.push("complex multi-event timeline");
  if (input.output.needsEscalation) reasons.push(`model flagged: ${input.output.escalationReason ?? "ambiguous rules"}`);
  const risky = active.find((e) => input.highRiskTerms.some((t) => e.complication.toLowerCase().includes(t.toLowerCase())));
  if (risky) reasons.push(`high-risk classification (${risky.complication})`);

  if (reasons.length === 0) return { escalate: false, reasons };
  if (!input.escalationModel || input.escalationModel === input.primaryModel) {
    return { escalate: false, reasons: [...reasons, "escalation model not configured or same as primary"] };
  }
  if (!input.forced) {
    const rate = (input.escalationsSoFar + 1) / Math.max(1, input.processedSoFar + 1);
    if (input.processedSoFar > 0 && rate > input.maxEscalationRate) {
      return { escalate: false, reasons: [...reasons, `escalation rate cap ${Math.round(input.maxEscalationRate * 100)}% reached`] };
    }
  }
  return { escalate: true, reasons };
}
