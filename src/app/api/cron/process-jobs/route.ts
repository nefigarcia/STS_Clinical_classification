import { after, NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { processRunnableJobs, triggerProcessing } from "@/lib/jobs/runner";
import { log, errorSummary } from "@/lib/security/logger";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = env().CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Background job pump. Called by Vercel Cron (GET, every minute) and by self-chaining
 * (POST). Responds immediately; work continues in after() within maxDuration.
 */
async function pump(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const jobId = req.nextUrl.searchParams.get("jobId") ?? undefined;
  after(async () => {
    try {
      const { results, workRemains } = await processRunnableJobs((maxDuration - 40) * 1000, jobId);
      const didWork = results.some((r) => r.processed > 0);
      // Chain only if this invocation made progress (avoids tight loops while another invocation holds the lease).
      if (workRemains && didWork) await triggerProcessing();
    } catch (err) {
      log.error("job pump failed", err);
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}

export async function GET(req: NextRequest) {
  return pump(req);
}
export async function POST(req: NextRequest) {
  try {
    return await pump(req);
  } catch (err) {
    log.error(`pump error ${errorSummary(err)}`);
    return NextResponse.json({ error: "error" }, { status: 500 });
  }
}
