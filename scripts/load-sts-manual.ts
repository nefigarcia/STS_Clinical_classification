/**
 * One-time (per version, per environment) load of the STS CHSD Training Manual into the database.
 * After this, the manual is static application data shared by all users; nobody uploads it at login.
 *
 *   npm run load:manual -- "reference-data/2026-07_CHSD TM Version 6.23.2.pdf" [--version 6.23.2]
 *        [--effective-from YYYY-MM-DD] [--effective-to YYYY-MM-DD] [--approve]
 *
 * - Idempotent: a file whose SHA-256 is already loaded is not re-indexed.
 * - Identity check rejects documents that are not the STS CHSD Training Manual.
 * - Embeds rule text (manual text only, never patient data) only if OPENAI_API_KEY is set.
 * - --approve records administrator approval (use after reviewing the printed statistics).
 * For Vercel: run against the production DATABASE_URL from a trusted machine/CI, like migrations.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db/prisma";
import { sha256 } from "../src/lib/data/normalization";
import { env } from "../src/lib/env";
import { parseAndStoreManual, embedRuleBatch, finishIndexing, manualStats } from "../src/lib/sts/manual-indexer";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const has = (name: string) => args.includes(`--${name}`);
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--approve"].includes(args[i - 1])));
const date = (s: string | null) => (s ? new Date(`${s}T00:00:00Z`) : null);

async function approve(id: string) {
  const hasDefault = await prisma.manualVersion.count({ where: { status: "APPROVED", isDefault: true, id: { not: id } } });
  await prisma.manualVersion.update({ where: { id }, data: { status: "APPROVED", approvedAt: new Date(), isDefault: hasDefault === 0 } });
  await prisma.classificationCache.updateMany({ where: { invalidatedAt: null }, data: { invalidatedAt: new Date() } });
  await prisma.auditLog.create({ data: { action: "manual.approve", entityType: "ManualVersion", entityId: id, metadata: { via: "cli" } } });
  console.log("Approved for classification.");
}

async function main() {
  if (!file) throw new Error('Usage: npm run load:manual -- "<path to manual.pdf>" [--version X] [--approve]');
  const buf = fs.readFileSync(file);
  const hash = sha256(buf);

  const existing = await prisma.manualVersion.findFirst({ where: { sha256: hash, status: { notIn: ["FAILED", "REJECTED"] } } });
  if (existing) {
    console.log(`Already loaded as version ${existing.version} (${existing.status}).`);
    console.log(await manualStats(existing.id));
    if (has("approve") && existing.status === "INDEXED") await approve(existing.id);
    return;
  }

  const sf = await prisma.sourceFile.create({
    data: {
      fileName: path.basename(file),
      fileType: "pdf",
      kind: "STS_MANUAL",
      dataClassification: "DEIDENTIFIED", // reference document, no patient data
      sha256: hash,
      sizeBytes: buf.length,
      content: buf,
      expectedChunks: 1,
      uploadComplete: true,
      status: "IMPORTED",
      importedAt: new Date(),
    },
  });
  const versionLabel =
    flag("version") ||
    path
      .basename(file)
      .match(/version\s*([\d.]+)/i)?.[1]
      ?.replace(/\.$/, "") ||
    "unversioned";
  if (await prisma.manualVersion.findUnique({ where: { version: versionLabel } }))
    throw new Error(`A different file is already registered as version ${versionLabel}`);
  const mv = await prisma.manualVersion.create({
    data: {
      version: versionLabel,
      fileName: sf.fileName,
      sha256: hash,
      sourceFileId: sf.id,
      effectiveFrom: date(flag("effective-from")),
      effectiveTo: date(flag("effective-to")),
    },
  });
  console.log(`Parsing ${sf.fileName} as version ${versionLabel}…`);
  const r = await parseAndStoreManual(mv.id); // throws (and marks REJECTED) if identity check fails
  console.log(`Pages: ${r.pageCount}. Rules extracted: ${r.rules}.`);
  if (r.toEmbed > 0) {
    let done = 0;
    for (let n = await embedRuleBatch(mv.id, null); n > 0; n = await embedRuleBatch(mv.id, null)) {
      done += n;
      process.stdout.write(`\rEmbedded ${done}/${r.toEmbed}`);
    }
    process.stdout.write("\n");
  } else {
    console.log(env().OPENAI_API_KEY ? "" : "OPENAI_API_KEY not set: keyword search only (re-run with a key later to add embeddings via Re-index).");
  }
  await finishIndexing(mv.id);
  await prisma.auditLog.create({
    data: { action: "manual.register", entityType: "ManualVersion", entityId: mv.id, metadata: { via: "cli", version: versionLabel } },
  });
  const after = await prisma.manualVersion.findUniqueOrThrow({ where: { id: mv.id } });
  console.log(`Detected version in PDF: ${after.detectedVersion ?? "n/a"}`);
  console.log(await manualStats(mv.id));
  if (has("approve")) await approve(mv.id);
  else console.log("Not approved yet. Review rules in STS Knowledge Base, then approve there or re-run with --approve.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
