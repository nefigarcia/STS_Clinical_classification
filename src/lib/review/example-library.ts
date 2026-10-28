import type { EvaluationCohort, User } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/errors";

/** Snapshot the currently approved examples as a new active library version. */
export async function snapshotLibrary(user: User, notes: string) {
  const approved = await prisma.historicalExample.findMany({
    where: { libraryStatus: "APPROVED", quality: "VERIFIED" },
    select: { id: true },
  });
  const last = await prisma.exampleLibraryVersion.findFirst({ orderBy: { version: "desc" } });
  const version = (last?.version ?? 0) + 1;
  await prisma.$transaction([
    prisma.exampleLibraryVersion.updateMany({ data: { active: false } }),
    prisma.exampleLibraryVersion.create({ data: { version, exampleIds: approved.map((a) => a.id), notes, active: true, createdById: user.id } }),
  ]);
  await audit({
    userId: user.id,
    action: "library.snapshot",
    entityType: "ExampleLibraryVersion",
    entityId: String(version),
    metadata: { count: approved.length },
  });
  return version;
}

/** Clinician verification of an example: VERIFIED + APPROVED enters the next library snapshot. */
export async function reviewExample(
  id: string,
  user: User,
  input: { action: "approve" | "reject" | "conflicting" | "insufficient"; cohort?: EvaluationCohort; comment?: string | null },
) {
  const ex = await prisma.historicalExample.findUnique({ where: { id } });
  if (!ex) throw new ApiError(404, "Example not found");
  if (input.action === "approve" && !ex.clinicalEvidence) throw new ApiError(400, "Cannot verify an example without clinical evidence");
  const data =
    input.action === "approve"
      ? { quality: "VERIFIED" as const, libraryStatus: "APPROVED" as const, validated: true }
      : input.action === "reject"
        ? { libraryStatus: "REJECTED" as const, validated: false }
        : {
            quality: input.action === "conflicting" ? ("CONFLICTING_EVIDENCE" as const) : ("INSUFFICIENT_EVIDENCE" as const),
            libraryStatus: "CANDIDATE" as const,
            validated: false,
          };
  await prisma.historicalExample.update({
    where: { id },
    data: {
      ...data,
      ...(input.cohort ? { cohort: input.cohort } : {}),
      reviewerId: user.id,
      reviewedAt: new Date(),
      qualityReason: input.comment ? `${ex.qualityReason ?? ""} | Reviewer: ${input.comment}`.slice(0, 2000) : undefined,
    },
  });
  await audit({
    userId: user.id,
    action: `example.${input.action}`,
    entityType: "HistoricalExample",
    entityId: id,
    metadata: { cohort: input.cohort ?? ex.cohort },
  });
  const version = await snapshotLibrary(user, `After ${input.action} of example`);
  return { version };
}

export async function setCohort(id: string, cohort: EvaluationCohort, user: User) {
  await prisma.historicalExample.update({ where: { id }, data: { cohort } });
  await audit({ userId: user.id, action: "example.set_cohort", entityType: "HistoricalExample", entityId: id, metadata: { cohort } });
}

/**
 * Assign cohorts at the PATIENT level to prevent leakage: every example of a patient
 * lands in the same cohort. Notes from one patient are never split across train/test.
 */
export async function assignCohortsByPatient(holdoutMrns: string[], user: User) {
  await prisma.historicalExample.updateMany({ where: { source: "HISTORICAL_IMPORT", cohort: { not: "INDEPENDENT_TEST" } }, data: { cohort: "DEVELOPMENT" } });
  if (holdoutMrns.length)
    await prisma.historicalExample.updateMany({ where: { mrn: { in: holdoutMrns }, cohort: { not: "INDEPENDENT_TEST" } }, data: { cohort: "HOLDOUT" } });
  await audit({ userId: user.id, action: "example.assign_cohorts", entityType: "HistoricalExample", metadata: { holdoutPatients: holdoutMrns.length } });
}

export async function activateLibraryVersion(version: number, user: User) {
  const v = await prisma.exampleLibraryVersion.findUnique({ where: { version } });
  if (!v) throw new ApiError(404, "Library version not found");
  await prisma.$transaction([
    prisma.exampleLibraryVersion.updateMany({ data: { active: false } }),
    prisma.exampleLibraryVersion.update({ where: { version }, data: { active: true } }),
  ]);
  await audit({ userId: user.id, action: "library.rollback", entityType: "ExampleLibraryVersion", entityId: String(version) });
}

export async function createPromptVersion(user: User, input: { version: string; systemPrompt: string; notes?: string | null; activate: boolean }) {
  const exists = await prisma.promptVersion.findUnique({ where: { version: input.version } });
  if (exists) throw new ApiError(409, "Prompt version already exists");
  await prisma.$transaction(async (tx) => {
    if (input.activate) await tx.promptVersion.updateMany({ data: { active: false } });
    await tx.promptVersion.create({
      data: { version: input.version, systemPrompt: input.systemPrompt, notes: input.notes ?? null, active: input.activate, createdById: user.id },
    });
  });
  await audit({ userId: user.id, action: "prompt.create", entityType: "PromptVersion", entityId: input.version, metadata: { activate: input.activate } });
}

export async function activatePromptVersion(version: string, user: User) {
  const p = await prisma.promptVersion.findUnique({ where: { version } });
  if (!p) throw new ApiError(404, "Prompt version not found");
  await prisma.$transaction([
    prisma.promptVersion.updateMany({ data: { active: false } }),
    prisma.promptVersion.update({ where: { version }, data: { active: true } }),
  ]);
  await audit({ userId: user.id, action: "prompt.activate", entityType: "PromptVersion", entityId: version });
}
