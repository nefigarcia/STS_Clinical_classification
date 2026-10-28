import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson, searchParams } from "@/lib/api";
import { addMissingComplication, addMissingSchema, decisionSchema, recordDecision } from "@/lib/review/review-service";

const postSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("decision"), predictionId: z.string(), data: decisionSchema }),
  z.object({ type: z.literal("add_missing"), encounterId: z.string(), data: addMissingSchema }),
]);

/** Review history for a prediction (append-only). */
export async function GET(req: Request) {
  return handle("GET /api/reviews", async () => {
    await requireRole("READ_ONLY");
    const predictionId = searchParams(req).get("predictionId");
    if (!predictionId) throw new ApiError(400, "predictionId required");
    const reviews = await prisma.reviewDecision.findMany({
      where: { predictionId },
      orderBy: { reviewedAt: "desc" },
      include: { reviewer: { select: { email: true, name: true } } },
    });
    return { reviews };
  });
}

export async function POST(req: Request) {
  return handle("POST /api/reviews", async () => {
    const user = await requireRole("REVIEWER");
    const body = await parseJson(req, postSchema);
    if (body.type === "decision") return recordDecision(body.predictionId, user, body.data);
    return addMissingComplication(body.encounterId, user, body.data);
  });
}
