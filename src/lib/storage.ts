import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { sha256 } from "@/lib/data/normalization";

export type UploadType = "xlsx" | "csv" | "pdf";

/** Each chunk stays below Vercel's 4.5 MB request-body limit (with multipart overhead). */
export const CHUNK_BYTES = 3 * 1024 * 1024;

export function typeFromName(fileName: string): { type: UploadType | null; error?: string } {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".xlsx") return { type: "xlsx" };
  if (ext === ".pdf") return { type: "pdf" };
  if (ext === ".csv") return { type: "csv" };
  return { type: null, error: `Unsupported file type "${ext}". Use .xlsx, .csv or .pdf.` };
}

/** Validate assembled bytes by content signature; never trust the client MIME type or extension alone. */
export function verifySignature(type: UploadType, buf: Buffer): string | null {
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
  if (type === "xlsx" && !isZip) return "File has .xlsx extension but is not a valid Excel workbook";
  if (type === "pdf" && !isPdf) return "File has .pdf extension but is not a PDF";
  if (type === "csv" && buf.subarray(0, Math.min(buf.length, 65536)).includes(0)) return "CSV contains binary content";
  return null;
}

/**
 * Malware scanning hook. No scanner is bundled; when MALWARE_SCAN_REQUIRED=true the
 * upload is refused until an institutional scanner is integrated here.
 */
export async function scanUpload(_buf: Buffer): Promise<{ ok: boolean; reason?: string }> {
  if ((process.env.MALWARE_SCAN_REQUIRED ?? "").toLowerCase() === "true") {
    return { ok: false, reason: "Malware scanning is required by configuration but no scanner is integrated." };
  }
  return { ok: true };
}

/** Concatenate stored chunks, verify, persist the assembled bytes and drop the chunks. */
export async function assembleUpload(sourceFileId: string): Promise<Buffer> {
  const file = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sourceFileId } });
  const chunks = await prisma.uploadChunk.findMany({ where: { sourceFileId }, orderBy: { index: "asc" } });
  if (chunks.length !== file.expectedChunks || chunks.some((c, i) => c.index !== i)) {
    throw new Error(`Upload incomplete: received ${chunks.length} of ${file.expectedChunks} chunks`);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.bytes)));
  if (buf.length !== file.sizeBytes) throw new Error("Upload size mismatch");
  const sigError = verifySignature(file.fileType as UploadType, buf);
  if (sigError) throw new Error(sigError);
  const scan = await scanUpload(buf);
  if (!scan.ok) throw new Error(scan.reason);
  await prisma.$transaction([
    prisma.sourceFile.update({
      where: { id: sourceFileId },
      data: { content: buf, sha256: sha256(buf), uploadComplete: true },
    }),
    prisma.uploadChunk.deleteMany({ where: { sourceFileId } }),
  ]);
  return buf;
}

export async function readStored(sourceFileId: string): Promise<Buffer> {
  const f = await prisma.sourceFile.findUniqueOrThrow({ where: { id: sourceFileId }, select: { content: true } });
  if (!f.content) throw new Error("File content not available (upload incomplete or purged)");
  return Buffer.from(f.content);
}
