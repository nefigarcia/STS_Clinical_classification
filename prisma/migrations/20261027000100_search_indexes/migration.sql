-- Hybrid-search support (not representable in the Prisma schema).
-- Requires the database role to own these tables; the vector extension itself is
-- created in the init migration and needs CREATE privilege on the database
-- (the default POSTGRES_USER in docker-compose is the database owner).

-- Full-text search over STS rule chunks.
CREATE INDEX IF NOT EXISTS "STSManualRule_fts_idx"
  ON "STSManualRule" USING GIN (to_tsvector('english', "chunkText"));

-- Approximate nearest-neighbour indexes (cosine distance). HNSW works on empty tables.
CREATE INDEX IF NOT EXISTS "STSManualRule_embedding_hnsw_idx"
  ON "STSManualRule" USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "HistoricalExample_embedding_hnsw_idx"
  ON "HistoricalExample" USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS "NotePassage_embedding_hnsw_idx"
  ON "NotePassage" USING hnsw (embedding vector_cosine_ops);

-- Partial identifier search in patient lookup.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "Patient_mrn_trgm_idx" ON "Patient" USING GIN (mrn gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Encounter_csn_trgm_idx" ON "Encounter" USING GIN (csn gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "ClinicalNote_noteId_trgm_idx" ON "ClinicalNote" USING GIN ("noteId" gin_trgm_ops);
