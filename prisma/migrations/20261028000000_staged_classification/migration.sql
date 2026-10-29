-- Staged classification: encounter timing fields, per-criterion results, screening cache.
-- (Hand-written search indexes from 20261027000100_search_indexes are intentionally untouched.)

-- AlterTable
ALTER TABLE "ComplicationPrediction" ADD COLUMN     "agreement" TEXT,
ADD COLUMN     "criteriaResults" JSONB,
ADD COLUMN     "timeframeCheck" JSONB;

-- AlterTable
ALTER TABLE "Encounter" ADD COLUMN     "databaseDischargeDate" TIMESTAMP(3),
ADD COLUMN     "dischargeDateSource" "SurgeryDateSource" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "orExitAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NoteScreenCache" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteScreenCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NoteScreenCache_cacheKey_key" ON "NoteScreenCache"("cacheKey");
