import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

type Tx = Prisma.TransactionClient | typeof prisma;

/** Append an audit record. Metadata must not contain note text. */
export async function audit(
  entry: {
    userId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
  tx: Tx = prisma,
) {
  await tx.auditLog.create({
    data: {
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata,
    },
  });
}
