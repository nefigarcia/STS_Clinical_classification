import type { DataClassification } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";

export type GateResult = { allowed: boolean; reasons: string[] };

const RANK: Record<DataClassification, number> = { SYNTHETIC: 0, DEIDENTIFIED: 1, PHI: 2 };

export function mostRestrictive(classes: DataClassification[]): DataClassification {
  return classes.reduce<DataClassification>((a, b) => (RANK[b] > RANK[a] ? b : a), "SYNTHETIC");
}

/** May data of this classification leave the environment to the configured OpenAI org? */
export function externalAiAllowedFor(classification: DataClassification): GateResult {
  const reasons: string[] = [];
  if (!env().OPENAI_API_KEY) reasons.push("OPENAI_API_KEY is not configured.");
  if (classification !== "SYNTHETIC" && !env().PHI_EXTERNAL_AI_APPROVED) {
    reasons.push(
      `Dataset is classified ${classification}. External AI processing of non-synthetic data requires PHI_EXTERNAL_AI_APPROVED=true after BAA, retention-control and Children's Nebraska compliance approval.`,
    );
  }
  return { allowed: reasons.length === 0, reasons };
}

/** An administrator-approved, indexed STS manual is required before any STS-based classification. */
export async function approvedManualAvailable(): Promise<GateResult> {
  const count = await prisma.manualVersion.count({ where: { status: "APPROVED" } });
  return count > 0
    ? { allowed: true, reasons: [] }
    : {
        allowed: false,
        reasons: [
          "No approved STS CHSD Training Manual is loaded. Upload and index the official manual PDF in STS Knowledge Base, then have an administrator approve it.",
        ],
      };
}

export async function encounterClassification(encounterId: string): Promise<DataClassification> {
  const rows = await prisma.clinicalNote.findMany({
    where: { encounterId },
    select: { sourceFile: { select: { dataClassification: true } } },
  });
  // Notes without a source file are treated as PHI (fail closed).
  return mostRestrictive(rows.map((r) => r.sourceFile?.dataClassification ?? "PHI"));
}

export async function classificationGate(dataClass: DataClassification): Promise<GateResult> {
  const a = externalAiAllowedFor(dataClass);
  const b = await approvedManualAvailable();
  return { allowed: a.allowed && b.allowed, reasons: [...a.reasons, ...b.reasons] };
}

export async function systemStatus() {
  const manual = await approvedManualAvailable();
  return {
    openaiConfigured: Boolean(env().OPENAI_API_KEY),
    phiExternalAiApproved: env().PHI_EXTERNAL_AI_APPROVED,
    approvedManual: manual.allowed,
    appEnv: env().APP_ENV,
  };
}
