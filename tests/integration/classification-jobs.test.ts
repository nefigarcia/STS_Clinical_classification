import { beforeEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";

/**
 * Mock only the network edge of the OpenAI client. The mock behaves like the real API contract:
 * it only sees what the prompt contains and must quote that text verbatim.
 */
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
const { setSetting, settingDefaults } = await import("@/lib/settings");
const { dbAvailable, resetDb, importSynthetic, approvedFixtureManual } = await import("./helpers");

const ready = await dbAvailable();
const usage = { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 50 } };

type Req = { model: string; input: { role: string; content: string }[]; text: { format: { name: string } }; store: boolean };

/** Stage A mock: report catalogue events whose wording appears in the note. */
function screen(user: string) {
  const note = user.split("<note")[1] ?? "";
  const m: { code: string; assertion: string; excerpt: string }[] = [];
  const add = (re: RegExp, code: string, assertion: string) => {
    const hit = note.match(re);
    if (hit) m.push({ code, assertion, excerpt: hit[0] });
  };
  add(/new right pneumothorax/, "T100", "affirmed");
  add(/No pneumothorax/, "T100", "negated");
  add(/consistent with chylothorax/, "T200", "affirmed");
  add(/temporary pacing/, "T300", "affirmed");
  return { mentions: m };
}

let pacingBehaviour: "agree" | "split" = "agree";
let pacingCalls = 0;

/** Stage B mock: answer the checklist with quotes from the given passages. */
function adjudicate(req: Req) {
  const user = req.input[1].content;
  const code = user.match(/Event under review: code (T\d+)/)![1];
  const passages = [...user.matchAll(/<passage label="(P\d+)"[^>]*>\n([\s\S]*?)\n<\/passage>/g)].map((x) => ({ label: x[1], text: x[2] }));
  const find = (s: string) => passages.find((p) => p.text.includes(s))!.label;
  const met = (id: string, s: string) => ({ id, status: "met", evidence: [{ passageRef: find(s), excerpt: s }], rationale: "documented" });
  const no = (id: string) => ({ id, status: "not_met", evidence: [], rationale: "not documented" });
  if (code === "T100")
    return {
      criteria: [met("D1", "new right pneumothorax"), met("C1", "chest tube placed at bedside"), no("E1")],
      eventDate: "2026-01-06",
      explanation: "Pneumothorax treated with chest tube.",
    };
  if (code === "T200")
    return {
      criteria: [met("D1", "consistent with chylothorax"), met("C1", "Started MCT formula and octreotide"), no("E1")],
      eventDate: null,
      explanation: "Chylothorax treated.",
    };
  pacingCalls++;
  const disagree = pacingBehaviour === "split" && req.model === "test-primary" && pacingCalls === 2;
  return {
    criteria: [met("D1", "Junctional ectopic tachycardia"), disagree ? no("C1") : met("C1", "treated with cooling and temporary pacing"), no("E1")],
    eventDate: "2026-01-07",
    explanation: "JET treated with temporary pacing.",
  };
}

function respond(req: Req) {
  const name = req.text.format.name;
  const out = name === "note_screening" ? screen(req.input[1].content) : adjudicate(req);
  return { output_parsed: out, usage };
}

describe.skipIf(!ready)("staged classification pipeline and jobs (database, mocked OpenAI)", () => {
  beforeEach(async () => {
    await resetDb();
    parseMock.mockReset();
    parseMock.mockImplementation(async (req: Req) => respond(req));
    pacingBehaviour = "agree";
    pacingCalls = 0;
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

  it("screens every note, adjudicates each flagged code against its checklist, and caches", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" }, include: { notes: true } });
    const r = await classifyEncounter(enc.id);

    const calls = parseMock.mock.calls.map((c) => c[0] as Req);
    const screens = calls.filter((c) => c.text.format.name === "note_screening");
    const adjudications = calls.filter((c) => c.text.format.name === "code_adjudication");
    expect(screens).toHaveLength(5); // every unique note in scope, none skipped by keywords
    expect(adjudications).toHaveLength(3 * 2); // 3 flagged codes × 2 consistency runs
    expect(calls.every((c) => c.store === false)).toBe(true);
    expect(calls.every((c) => !c.input[1].content.includes("0001001") && !c.input[1].content.includes("000900002"))).toBe(true);

    const preds = await prisma.complicationPrediction.findMany({
      where: { encounterId: enc.id, supersededAt: null },
      include: { evidence: { include: { clinicalNote: true } } },
    });
    expect(preds.map((p) => p.stsCode).sort()).toEqual(["T100", "T200", "T300"]);
    for (const p of preds) {
      expect(p.classificationStatus).toBe("SUGGESTED");
      expect(p.reviewStatus).toBe("PENDING"); // never auto-approved
      expect(p.agreement).toBe("2/2 runs agree");
      expect(p.evidence.every((e) => e.verified)).toBe(true);
    }
    const ptx = preds.find((p) => p.stsCode === "T100")!;
    expect(ptx.evidence.map((e) => e.clinicalNote.noteId)).toEqual(["000900002", "000900002"]);
    expect(ptx.manualPage).toBe(10);
    expect((ptx.criteriaResults as { id: string; effectiveStatus: string }[]).map((c) => [c.id, c.effectiveStatus])).toEqual([
      ["D1", "met"],
      ["C1", "met"],
      ["E1", "not_met"],
    ]);
    expect(ptx.timeframeCheck).toMatchObject({ status: "in_window", eventDate: "2026-01-06" });
    const chy = preds.find((p) => p.stsCode === "T200")!;
    expect(chy.timeframeCheck).toMatchObject({ eventDate: "2026-01-09", eventDateSource: expect.stringMatching(/earliest evidence note/) });
    expect(r.notesScreened).toBe(5);

    // Whole-encounter cache: no new calls.
    parseMock.mockClear();
    expect((await classifyEncounter(enc.id)).cacheHit).toBe(true);
    expect(parseMock).not.toHaveBeenCalled();

    // Screening cache: after invalidation only adjudication re-runs; unchanged notes are never re-screened.
    await prisma.classificationCache.updateMany({ data: { invalidatedAt: new Date() } });
    await classifyEncounter(enc.id);
    expect(parseMock.mock.calls.filter((c) => (c[0] as Req).text.format.name === "note_screening")).toHaveLength(0);
  });

  it("applies the STS timeframe in code: events before the index operation are excluded", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" } });
    await prisma.encounter.update({ where: { id: enc.id }, data: { surgeryDate: new Date("2026-01-08T00:00:00Z"), surgeryDateSource: "MANUAL" } });
    await classifyEncounter(enc.id);
    const ptx = await prisma.complicationPrediction.findFirstOrThrow({ where: { encounterId: enc.id, stsCode: "T100", supersededAt: null } });
    expect(ptx.classificationStatus).toBe("EXCLUDED");
    expect(ptx.timeframeCheck).toMatchObject({ status: "before_window" });
  });

  it("sends disagreeing consistency runs to the escalation model and always to human review", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    pacingBehaviour = "split";
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" } });
    const r = await classifyEncounter(enc.id);
    expect(r.escalated).toBe(true);
    const pacing = await prisma.complicationPrediction.findFirstOrThrow({ where: { encounterId: enc.id, stsCode: "T300", supersededAt: null } });
    expect(pacing.agreement).toMatch(/^split \(positive vs negative\); tie-break by test-escalation: positive/);
    expect(pacing.reviewStatus).toBe("NEEDS_REVIEW");
    expect(await prisma.aiCall.count({ where: { purpose: "adjudication-tiebreak", model: "test-escalation" } })).toBe(1);
  });

  it("retries rate-limited calls and meters every attempt", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    let first = true;
    parseMock.mockImplementation(async (req: Req) => {
      if (first) {
        first = false;
        throw OpenAI.APIError.generate(429, { message: "rate limited" }, "rate limited", new Headers());
      }
      return respond(req);
    });
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" } });
    await classifyEncounter(enc.id);
    const firstCall = await prisma.aiCall.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
    expect(firstCall).toMatchObject({ purpose: "screening", retries: 1, success: true });
  }, 60_000);

  it("pauses jobs at budget limits and resumes from where they stopped", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    await setSetting("processingLimits", { ...settingDefaults.processingLimits, maxJobTokenBudget: 1, retryLimit: 0 });
    const encs = await prisma.encounter.findMany();
    const job = await createJob({ type: "CLASSIFICATION", items: encs.map((e) => ({ encounterId: e.id })) });
    await runJobTick(job.id, 60_000);
    let j = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.processingStatus).toBe("PAUSED");
    expect(JSON.stringify(j.errors)).toMatch(/token budget/);

    await setSetting("processingLimits", { ...settingDefaults.processingLimits, retryLimit: 0 });
    await prisma.processingJob.update({ where: { id: job.id }, data: { processingStatus: "QUEUED" } });
    const t = await runJobTick(job.id, 120_000);
    j = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(t.status).toBe("COMPLETED");
    expect(j.processedRecords).toBe(2);
  }, 120_000);

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
