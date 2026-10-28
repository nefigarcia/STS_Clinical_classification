import { beforeEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import type { ModelOutput } from "@/lib/ai/response-schema";

// Mock only the network edge of the OpenAI client. Retry/limit logic stays real.
const parseMock = vi.fn();
vi.mock("@/lib/ai/openai-client", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/openai-client")>();
  return {
    ...real,
    openai: () => ({ responses: { parse: parseMock }, embeddings: { create: vi.fn() }, models: { retrieve: vi.fn() } }),
    modelConfig: () => ({ primary: "test-primary", escalation: "test-escalation", embedding: "test-embed", primaryEffort: "low", escalationEffort: "medium" }),
  };
});

const { prisma } = await import("@/lib/db/prisma");
const { classifyEncounter, GateClosedError } = await import("@/lib/ai/classifier");
const { createJob, runJobTick } = await import("@/lib/jobs/runner");
const { setSetting } = await import("@/lib/settings");
const { dbAvailable, resetDb, importSynthetic, approvedFixtureManual } = await import("./helpers");

const ready = await dbAvailable();

function response(output: ModelOutput) {
  return {
    output_parsed: output,
    usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 50 } },
  };
}

/** The mock "model" answers using passage labels it was given, exactly like the real API contract. */
function answerFromPrompt(build: (prompt: string) => ModelOutput) {
  return async (req: { input: { role: string; content: string }[] }) => response(build(req.input[1].content));
}
const labelFor = (prompt: string, needle: string) => {
  const m = [...prompt.matchAll(/<passage label="(P\d+)"[^>]*>\n([\s\S]*?)\n<\/passage>/g)].find((x) => x[2].includes(needle));
  if (!m) throw new Error(`passage containing "${needle}" not sent`);
  return m[1];
};
const ruleFor = (prompt: string, code: string) => prompt.match(new RegExp(`<rule label="(R\\d+)"[^>]*>\\n[^<]*Code ${code}:`))?.[1] ?? null;

describe.skipIf(!ready)("classification pipeline and jobs (database, mocked OpenAI)", () => {
  beforeEach(async () => {
    await resetDb();
    parseMock.mockReset();
  });

  it("is disabled until an approved STS manual exists", async () => {
    await importSynthetic();
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" } });
    await expect(classifyEncounter(enc.id)).rejects.toBeInstanceOf(GateClosedError);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("blocks non-synthetic data from external AI without PHI approval", async () => {
    await importSynthetic("PHI");
    await approvedFixtureManual();
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" } });
    await expect(classifyEncounter(enc.id)).rejects.toThrow(/PHI_EXTERNAL_AI_APPROVED/);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it("classifies multiple complications with traceable, verified evidence and caches the result", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" } });
    parseMock.mockImplementation(
      answerFromPrompt((p) => ({
        needsEscalation: false,
        escalationReason: null,
        events: [
          {
            complication: "Pneumothorax",
            ruleRef: ruleFor(p, "T100"),
            stsCode: "T100",
            assertion: "confirmed",
            evidenceStatus: "supported",
            eventDate: "2026-01-06",
            evidence: [{ passageRef: labelFor(p, "new right pneumothorax"), excerpt: "Chest X-ray shows new right pneumothorax" }],
            explanation: "e",
            confidenceScore: 0.9,
            uncertainty: "low",
          },
          {
            complication: "Chylothorax",
            ruleRef: ruleFor(p, "T200"),
            stsCode: "T200",
            assertion: "confirmed",
            evidenceStatus: "supported",
            eventDate: "2026-01-09",
            evidence: [{ passageRef: labelFor(p, "pleural triglycerides"), excerpt: "consistent with chylothorax" }],
            explanation: "e",
            confidenceScore: 0.9,
            uncertainty: "low",
          },
          {
            complication: "Seizure",
            ruleRef: null,
            stsCode: null,
            assertion: "negated",
            evidenceStatus: "insufficient",
            eventDate: null,
            evidence: [{ passageRef: labelFor(p, "Denies seizure"), excerpt: "Denies seizure activity" }],
            explanation: "negated",
            confidenceScore: null,
            uncertainty: "low",
          },
        ],
      })),
    );
    const r = await classifyEncounter(enc.id);
    expect(r.cacheHit).toBe(false);
    expect(parseMock).toHaveBeenCalledTimes(1);
    const call = parseMock.mock.calls[0][0];
    expect(call.store).toBe(false);
    expect(call.input[1].content).not.toContain("0001001"); // no MRN sent
    const preds = await prisma.complicationPrediction.findMany({
      where: { encounterId: enc.id, supersededAt: null },
      include: { evidence: { include: { clinicalNote: true } } },
    });
    const active = preds.filter((p) => p.classificationStatus !== "EXCLUDED");
    expect(active.map((p) => p.stsCode).sort()).toEqual(["T100", "T200"]);
    expect(active.every((p) => p.reviewStatus === "PENDING")).toBe(true);
    const ptx = active.find((p) => p.stsCode === "T100")!;
    expect(ptx.evidence[0].clinicalNote.noteId).toBe("000900002");
    expect(ptx.evidence[0].verified).toBe(true);
    expect(ptx.manualPage).toBe(10);
    expect(preds.find((p) => p.predictedComplication === "Seizure")!.classificationStatus).toBe("EXCLUDED");
    expect(await prisma.aiCall.count({ where: { success: true } })).toBe(1);

    const again = await classifyEncounter(enc.id);
    expect(again.cacheHit).toBe(true);
    expect(parseMock).toHaveBeenCalledTimes(1);
  });

  it("escalates when the primary result fails validation, and retries rate-limited calls", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" } });
    let call = 0;
    parseMock.mockImplementation(async (req: { model: string; input: { content: string }[] }) => {
      call++;
      if (call === 1) throw OpenAI.APIError.generate(429, { message: "rate limited" }, "rate limited", new Headers());
      const p = req.input[1].content;
      const code = req.model === "test-primary" ? "INVENTED-9" : "T100";
      return response({
        needsEscalation: false,
        escalationReason: null,
        events: [
          {
            complication: "Pneumothorax",
            ruleRef: null,
            stsCode: code,
            assertion: "confirmed",
            evidenceStatus: "supported",
            eventDate: null,
            evidence: [
              { passageRef: labelFor(p, "new right pneumothorax"), excerpt: req.model === "test-primary" ? "fabricated quote" : "new right pneumothorax" },
            ],
            explanation: "e",
            confidenceScore: 0.5,
            uncertainty: "medium",
          },
        ],
      });
    });
    const r = await classifyEncounter(enc.id);
    expect(r.escalated).toBe(true);
    expect(r.modelUsed).toBe("test-escalation");
    expect(r.escalationReasons.join()).toMatch(/failed validation/);
    const calls = await prisma.aiCall.findMany({ orderBy: { createdAt: "asc" } });
    expect(calls.map((c) => [c.model, c.retries])).toEqual([
      ["test-primary", 1],
      ["test-escalation", 0],
    ]);
  }, 60_000);

  it("pauses jobs at budget limits and resumes from where they stopped", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    await setSetting("processingLimits", {
      maxJobTokenBudget: 1,
      maxEncounterCostUsd: 2,
      maxEscalationRate: 0,
      concurrency: 1,
      retryLimit: 0,
      dailyCostLimitUsd: 50,
    });
    parseMock.mockResolvedValue(response({ events: [], needsEscalation: false, escalationReason: null }));
    const encs = await prisma.encounter.findMany();
    const job = await createJob({ type: "CLASSIFICATION", items: encs.map((e) => ({ encounterId: e.id })) });
    await runJobTick(job.id, 60_000);
    let j = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.processingStatus).toBe("PAUSED");
    expect(j.processedRecords).toBe(1);
    expect(JSON.stringify(j.errors)).toMatch(/token budget/);

    await setSetting("processingLimits", {
      maxJobTokenBudget: 1_000_000,
      maxEncounterCostUsd: 2,
      maxEscalationRate: 0,
      concurrency: 1,
      retryLimit: 0,
      dailyCostLimitUsd: 50,
    });
    await prisma.processingJob.update({ where: { id: job.id }, data: { processingStatus: "QUEUED" } });
    const t = await runJobTick(job.id, 60_000);
    j = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(t.status).toBe("COMPLETED");
    expect(j.processedRecords).toBe(2);
  });

  it("runs local historical evidence-mapping jobs and prevents concurrent ticks via leases", async () => {
    await importSynthetic();
    const exs = await prisma.historicalExample.findMany({ select: { id: true } });
    const job = await createJob({ type: "HISTORICAL_PREP", items: exs.map((e) => ({ refId: e.id })) });
    const [a, b] = await Promise.all([runJobTick(job.id, 60_000), runJobTick(job.id, 60_000)]);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
    const j = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.processingStatus).toBe("COMPLETED");
    expect(j.processedRecords).toBe(5);
  });
});
