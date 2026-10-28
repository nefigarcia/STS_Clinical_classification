import { extractText, getDocumentProxy } from "unpdf";

export type PdfPages = { totalPages: number; pages: string[] };

/** Extract text per page, preserving page numbers (pages[0] = page 1). */
export async function extractPdfPages(buf: Buffer): Promise<PdfPages> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return { totalPages, pages: text };
}

export type IdentityCheck = {
  isStsChsdManual: boolean;
  detectedVersion: string | null;
  signals: Record<string, boolean>;
  reason: string;
};

/**
 * Confirm a PDF is an STS Congenital Heart Surgery Database Training Manual before it
 * can be indexed. Unrelated documents (e.g. vendor order forms) are rejected.
 */
export function checkManualIdentity(pages: string[]): IdentityCheck {
  const head = pages.slice(0, 15).join("\n");
  const all = pages.length > 15 ? head + "\n" + pages.slice(15, 60).join("\n") : head;
  const signals = {
    societyOfThoracicSurgeons: /society of thoracic surgeons|\bSTS\b/i.test(all),
    congenitalHeartSurgery: /congenital heart surgery/i.test(all),
    trainingManualOrSpec: /training manual|data specifications?|data manager/i.test(all),
    fieldStructure: /long name|short name|seq(uence)?\.?\s*#|intent\s*\/\s*clarification/i.test(pages.slice(0, 200).join("\n")),
  };
  const versionMatch = head.match(/version\s*:?\s*(\d+(?:\.\d+){1,3})/i);
  const ok = signals.societyOfThoracicSurgeons && signals.congenitalHeartSurgery && signals.trainingManualOrSpec;
  return {
    isStsChsdManual: ok,
    detectedVersion: versionMatch?.[1] ?? null,
    signals,
    reason: ok
      ? "Document identifies itself as an STS Congenital Heart Surgery Database training manual."
      : "Document does not identify as an STS CHSD Training Manual (missing: " +
        Object.entries(signals)
          .filter(([k, v]) => !v && k !== "fieldStructure")
          .map(([k]) => k)
          .join(", ") +
        ").",
  };
}
