/**
 * Local background worker: repeatedly processes queued jobs in-process.
 * Alternative to Vercel Cron for local development (`npm run worker`).
 * In production on Vercel, /api/cron/process-jobs + after() chaining do this.
 */
import "dotenv/config";
import { processRunnableJobs } from "../src/lib/jobs/runner";
import { prisma } from "../src/lib/db/prisma";
import { log } from "../src/lib/security/logger";

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

async function main() {
  log.info("worker started");
  while (!stopping) {
    try {
      const { results, workRemains } = await processRunnableJobs(240_000);
      const processed = results.reduce((a, r) => a + r.processed, 0);
      if (processed) log.info("worker tick", { processed });
      if (!workRemains || processed === 0) await new Promise((r) => setTimeout(r, 5000));
    } catch (err) {
      log.error("worker tick failed", err);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  await prisma.$disconnect();
  log.info("worker stopped");
}

main();
