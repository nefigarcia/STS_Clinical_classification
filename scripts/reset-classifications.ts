/**
 * CLI equivalent of Settings → "Reset classification data" (testing only; refused in production).
 *
 *   npm run reset:classifications                                    # dry run
 *   npm run reset:classifications -- --yes                           # delete
 *   npm run reset:classifications -- --yes --include-screening-cache # also forget note screening
 */
import "dotenv/config";
import { prisma } from "../src/lib/db/prisma";
import { previewReset, resetClassifications } from "../src/lib/admin/reset";

const args = process.argv.slice(2);
const includeScreeningCache = args.includes("--include-screening-cache");

async function main() {
  if (!args.includes("--yes")) {
    console.table(await previewReset(includeScreeningCache));
    console.log("Dry run only. Re-run with --yes to delete.");
    return;
  }
  console.table(await resetClassifications({ includeScreeningCache, userId: null, via: "cli" }));
  console.log("Classification data reset. Notes, manual, historical labels and audit log were kept.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
