-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'REVIEWER', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "DataClassification" AS ENUM ('SYNTHETIC', 'DEIDENTIFIED', 'PHI');

-- CreateEnum
CREATE TYPE "SourceFileKind" AS ENUM ('CLINICAL_NOTES', 'HISTORICAL_COMPLICATIONS', 'STS_MANUAL');

-- CreateEnum
CREATE TYPE "SourceFileStatus" AS ENUM ('UPLOADED', 'VALIDATED', 'IMPORTED', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceRowStatus" AS ENUM ('VALID', 'INVALID', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "SurgeryDateSource" AS ENUM ('UNKNOWN', 'DERIVED_FROM_OP_NOTE', 'MANUAL');

-- CreateEnum
CREATE TYPE "ManualStatus" AS ENUM ('UPLOADED', 'INDEXING', 'INDEXED', 'APPROVED', 'RETIRED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ClassificationStatus" AS ENUM ('SUGGESTED', 'SUSPECTED', 'INSUFFICIENT_EVIDENCE', 'CONFLICTING_EVIDENCE', 'EXCLUDED', 'REVIEWER_ADDED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CORRECTED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ReviewDecisionType" AS ENUM ('APPROVE', 'REJECT', 'CORRECT', 'ADD_MISSING', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ExampleQuality" AS ENUM ('VERIFIED', 'PENDING_VERIFICATION', 'CONFLICTING_EVIDENCE', 'INSUFFICIENT_EVIDENCE');

-- CreateEnum
CREATE TYPE "ExampleSource" AS ENUM ('HISTORICAL_IMPORT', 'REVIEWER_FEEDBACK');

-- CreateEnum
CREATE TYPE "ExampleLibraryStatus" AS ENUM ('CANDIDATE', 'APPROVED', 'REJECTED', 'RETIRED');

-- CreateEnum
CREATE TYPE "EvaluationCohort" AS ENUM ('DEVELOPMENT', 'HOLDOUT', 'INDEPENDENT_TEST');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('CLASSIFICATION', 'MANUAL_INDEXING', 'HISTORICAL_PREP', 'EVALUATION');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobItemStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "entraOid" TEXT,
    "role" "Role" NOT NULL DEFAULT 'READ_ONLY',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceFile" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "kind" "SourceFileKind" NOT NULL,
    "dataClassification" "DataClassification" NOT NULL,
    "sha256" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "content" BYTEA,
    "expectedChunks" INTEGER NOT NULL,
    "uploadComplete" BOOLEAN NOT NULL DEFAULT false,
    "sheetName" TEXT,
    "columnMapping" JSONB,
    "importReport" JSONB,
    "status" "SourceFileStatus" NOT NULL DEFAULT 'UPLOADED',
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMP(3),

    CONSTRAINT "SourceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadChunk" (
    "id" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,

    CONSTRAINT "UploadChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceRow" (
    "id" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "status" "SourceRowStatus" NOT NULL,
    "issues" JSONB,
    "clinicalNoteId" TEXT,

    CONSTRAINT "SourceRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" TEXT NOT NULL,
    "mrn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Encounter" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "csn" TEXT NOT NULL,
    "admissionDate" TIMESTAMP(3),
    "surgeryDate" TIMESTAMP(3),
    "surgeryDateSource" "SurgeryDateSource" NOT NULL DEFAULT 'UNKNOWN',
    "dischargeDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Encounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalNote" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "noteType" TEXT,
    "dateOfService" TIMESTAMP(3),
    "dateOfServiceRaw" TEXT,
    "filedDate" TIMESTAMP(3),
    "combinedNoteText" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceFileId" TEXT,
    "sourceFlag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotePassage" (
    "id" TEXT NOT NULL,
    "clinicalNoteId" TEXT NOT NULL,
    "start" INTEGER NOT NULL,
    "end" INTEGER NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embedding" vector(1536),

    CONSTRAINT "NotePassage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "pageCount" INTEGER,
    "detectedVersion" TEXT,
    "identityCheck" JSONB,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" "ManualStatus" NOT NULL DEFAULT 'UPLOADED',
    "embeddingModel" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "STSManualRule" (
    "id" TEXT NOT NULL,
    "manualVersionId" TEXT NOT NULL,
    "manualVersion" TEXT NOT NULL,
    "sectionName" TEXT,
    "pageNumber" INTEGER NOT NULL,
    "pageEnd" INTEGER,
    "longName" TEXT,
    "shortName" TEXT,
    "seqNumber" TEXT,
    "dbTable" TEXT,
    "stsCode" TEXT,
    "complicationName" TEXT,
    "definition" TEXT,
    "intentClarification" TEXT,
    "codingInstructions" TEXT,
    "validCodes" JSONB,
    "parentConditions" TEXT,
    "inclusionExclusion" TEXT,
    "specialNotes" TEXT,
    "chunkText" TEXT NOT NULL,
    "isComplicationRule" BOOLEAN NOT NULL DEFAULT false,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "STSManualRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplicationPrediction" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "jobId" TEXT,
    "predictedComplication" TEXT NOT NULL,
    "stsCode" TEXT,
    "complicationEventDate" TIMESTAMP(3),
    "classificationStatus" "ClassificationStatus" NOT NULL,
    "eventAssertion" TEXT,
    "evidenceStatus" TEXT NOT NULL,
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "finalComplication" TEXT,
    "finalStsCode" TEXT,
    "confidenceScore" DOUBLE PRECISION,
    "uncertainty" TEXT,
    "clinicalEvidence" TEXT,
    "aiExplanation" TEXT,
    "validationIssues" JSONB,
    "manualReferenceId" TEXT,
    "manualVersionId" TEXT,
    "manualPage" INTEGER,
    "manualSection" TEXT,
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "exampleLibraryVersion" INTEGER,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "cacheKey" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplicationPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PredictionEvidence" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "clinicalNoteId" TEXT NOT NULL,
    "evidenceText" TEXT NOT NULL,
    "evidenceStart" INTEGER,
    "evidenceEnd" INTEGER,
    "evidenceType" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PredictionEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewDecision" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "ReviewDecisionType" NOT NULL,
    "previousStatus" "ReviewStatus" NOT NULL,
    "correctedComplication" TEXT,
    "correctedStsCode" TEXT,
    "comments" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalExample" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT,
    "sourceFileId" TEXT,
    "sourceRowNumber" INTEGER,
    "source" "ExampleSource" NOT NULL DEFAULT 'HISTORICAL_IMPORT',
    "mrn" TEXT NOT NULL,
    "csn" TEXT NOT NULL,
    "dateOfService" TIMESTAMP(3),
    "dateOfServiceRaw" TEXT,
    "originalLabel" TEXT NOT NULL,
    "complication" TEXT NOT NULL,
    "noteInfo" TEXT,
    "keyWords" TEXT,
    "additionalInfo" TEXT,
    "clinicalEvidence" TEXT,
    "supportingNoteIds" TEXT[],
    "candidateNoteIds" TEXT[],
    "quality" "ExampleQuality" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "qualityReason" TEXT,
    "libraryStatus" "ExampleLibraryStatus" NOT NULL DEFAULT 'CANDIDATE',
    "cohort" "EvaluationCohort" NOT NULL DEFAULT 'DEVELOPMENT',
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "stsRuleId" TEXT,
    "predictionId" TEXT,
    "embeddingModel" TEXT,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalExample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExampleLibraryVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "exampleIds" TEXT[],
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExampleLibraryVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "fileName" TEXT,
    "sourceFileId" TEXT,
    "manualVersionId" TEXT,
    "processingStatus" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "processedRecords" INTEGER NOT NULL DEFAULT 0,
    "failedRecords" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "params" JSONB,
    "result" JSONB,
    "currentModel" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "tokenUsage" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" DOUBLE PRECISION,
    "actualCost" DOUBLE PRECISION,
    "createdById" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "lockOwner" TEXT,
    "lastTickAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "encounterId" TEXT,
    "refId" TEXT,
    "status" "JobItemStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "costUsd" DOUBLE PRECISION,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCall" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "encounterId" TEXT,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reasoningEffort" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION,
    "durationMs" INTEGER NOT NULL,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassificationCache" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "manualVersion" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "ClassificationCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationRun" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT,
    "manualVersion" TEXT,
    "cohort" "EvaluationCohort" NOT NULL,
    "libraryVersion" INTEGER,
    "jobId" TEXT,
    "metrics" JSONB,
    "results" JSONB,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_entraOid_key" ON "User"("entraOid");

-- CreateIndex
CREATE INDEX "SourceFile_sha256_idx" ON "SourceFile"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "UploadChunk_sourceFileId_index_key" ON "UploadChunk"("sourceFileId", "index");

-- CreateIndex
CREATE INDEX "SourceRow_clinicalNoteId_idx" ON "SourceRow"("clinicalNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRow_sourceFileId_rowNumber_key" ON "SourceRow"("sourceFileId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_mrn_key" ON "Patient"("mrn");

-- CreateIndex
CREATE INDEX "Encounter_csn_idx" ON "Encounter"("csn");

-- CreateIndex
CREATE UNIQUE INDEX "Encounter_patientId_csn_key" ON "Encounter"("patientId", "csn");

-- CreateIndex
CREATE INDEX "ClinicalNote_noteId_idx" ON "ClinicalNote"("noteId");

-- CreateIndex
CREATE INDEX "ClinicalNote_contentHash_idx" ON "ClinicalNote"("contentHash");

-- CreateIndex
CREATE INDEX "ClinicalNote_encounterId_dateOfService_idx" ON "ClinicalNote"("encounterId", "dateOfService");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalNote_encounterId_noteId_contentHash_key" ON "ClinicalNote"("encounterId", "noteId", "contentHash");

-- CreateIndex
CREATE INDEX "NotePassage_clinicalNoteId_idx" ON "NotePassage"("clinicalNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualVersion_version_key" ON "ManualVersion"("version");

-- CreateIndex
CREATE INDEX "STSManualRule_manualVersionId_idx" ON "STSManualRule"("manualVersionId");

-- CreateIndex
CREATE INDEX "STSManualRule_stsCode_idx" ON "STSManualRule"("stsCode");

-- CreateIndex
CREATE INDEX "ComplicationPrediction_encounterId_idx" ON "ComplicationPrediction"("encounterId");

-- CreateIndex
CREATE INDEX "ComplicationPrediction_reviewStatus_idx" ON "ComplicationPrediction"("reviewStatus");

-- CreateIndex
CREATE INDEX "ComplicationPrediction_predictedComplication_idx" ON "ComplicationPrediction"("predictedComplication");

-- CreateIndex
CREATE INDEX "PredictionEvidence_predictionId_idx" ON "PredictionEvidence"("predictionId");

-- CreateIndex
CREATE INDEX "PredictionEvidence_clinicalNoteId_idx" ON "PredictionEvidence"("clinicalNoteId");

-- CreateIndex
CREATE INDEX "ReviewDecision_predictionId_reviewedAt_idx" ON "ReviewDecision"("predictionId", "reviewedAt");

-- CreateIndex
CREATE INDEX "HistoricalExample_encounterId_idx" ON "HistoricalExample"("encounterId");

-- CreateIndex
CREATE INDEX "HistoricalExample_quality_libraryStatus_idx" ON "HistoricalExample"("quality", "libraryStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ExampleLibraryVersion_version_key" ON "ExampleLibraryVersion"("version");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_version_key" ON "PromptVersion"("version");

-- CreateIndex
CREATE INDEX "ProcessingJob_processingStatus_idx" ON "ProcessingJob"("processingStatus");

-- CreateIndex
CREATE INDEX "JobItem_jobId_status_idx" ON "JobItem"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JobItem_jobId_encounterId_key" ON "JobItem"("jobId", "encounterId");

-- CreateIndex
CREATE INDEX "AiCall_createdAt_idx" ON "AiCall"("createdAt");

-- CreateIndex
CREATE INDEX "AiCall_jobId_idx" ON "AiCall"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassificationCache_cacheKey_key" ON "ClassificationCache"("cacheKey");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

-- AddForeignKey
ALTER TABLE "SourceFile" ADD CONSTRAINT "SourceFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadChunk" ADD CONSTRAINT "UploadChunk_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "SourceFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceRow" ADD CONSTRAINT "SourceRow_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "SourceFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceRow" ADD CONSTRAINT "SourceRow_clinicalNoteId_fkey" FOREIGN KEY ("clinicalNoteId") REFERENCES "ClinicalNote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalNote" ADD CONSTRAINT "ClinicalNote_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "SourceFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotePassage" ADD CONSTRAINT "NotePassage_clinicalNoteId_fkey" FOREIGN KEY ("clinicalNoteId") REFERENCES "ClinicalNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualVersion" ADD CONSTRAINT "ManualVersion_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "SourceFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualVersion" ADD CONSTRAINT "ManualVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "STSManualRule" ADD CONSTRAINT "STSManualRule_manualVersionId_fkey" FOREIGN KEY ("manualVersionId") REFERENCES "ManualVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplicationPrediction" ADD CONSTRAINT "ComplicationPrediction_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplicationPrediction" ADD CONSTRAINT "ComplicationPrediction_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplicationPrediction" ADD CONSTRAINT "ComplicationPrediction_manualReferenceId_fkey" FOREIGN KEY ("manualReferenceId") REFERENCES "STSManualRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplicationPrediction" ADD CONSTRAINT "ComplicationPrediction_manualVersionId_fkey" FOREIGN KEY ("manualVersionId") REFERENCES "ManualVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PredictionEvidence" ADD CONSTRAINT "PredictionEvidence_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "ComplicationPrediction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PredictionEvidence" ADD CONSTRAINT "PredictionEvidence_clinicalNoteId_fkey" FOREIGN KEY ("clinicalNoteId") REFERENCES "ClinicalNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "ComplicationPrediction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewDecision" ADD CONSTRAINT "ReviewDecision_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalExample" ADD CONSTRAINT "HistoricalExample_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalExample" ADD CONSTRAINT "HistoricalExample_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "SourceFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalExample" ADD CONSTRAINT "HistoricalExample_stsRuleId_fkey" FOREIGN KEY ("stsRuleId") REFERENCES "STSManualRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalExample" ADD CONSTRAINT "HistoricalExample_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "ComplicationPrediction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "SourceFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItem" ADD CONSTRAINT "JobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobItem" ADD CONSTRAINT "JobItem_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCall" ADD CONSTRAINT "AiCall_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassificationCache" ADD CONSTRAINT "ClassificationCache_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
