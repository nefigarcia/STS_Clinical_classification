# STS CHSD Complication Classification Platform

A clinical abstraction and review application for **Children's Nebraska**. It suggests postoperative complications from clinical notes according to the **STS Congenital Heart Surgery Database (CHSD) Training Manual**. A clinical reviewer then approves, rejects or corrects every suggestion.

> **Status: development build. Not validated for clinical use.**
> Nothing in this repository establishes clinical accuracy, HIPAA compliance or STS coding correctness. AI output is a suggestion until a clinical reviewer decides on it. Production use requires institutional security/compliance approval and clinical validation on an independent, clinically reviewed cohort.

---

## Contents

1. [Architecture](#architecture)
2. [Quick start (local)](#quick-start-local)
3. [Environment variables](#environment-variables)
4. [Importing data](#importing-data)
5. [Loading the STS manual](#loading-the-sts-manual)
6. [AI processing](#ai-processing)
7. [Review, export and continuous learning](#review-export-and-continuous-learning)
8. [Historical validation](#historical-validation)
9. [Security and PHI safeguards](#security-and-phi-safeguards)
10. [Deploying to Vercel](#deploying-to-vercel)
11. [Testing](#testing)
12. [Project structure](#project-structure)
13. [Known limitations and unverified assumptions](#known-limitations-and-unverified-assumptions)

---

## Architecture

| Layer | Technology |
| --- | --- |
| App (UI and API) | Next.js 16 (App Router, Route Handlers, Server/Client Components), TypeScript, React 19 |
| UI | Tailwind CSS v4, shadcn/ui (Base UI), Lucide icons, TanStack Table, React Hook Form + Zod, Recharts |
| Database | PostgreSQL 17 + **pgvector** (Prisma ORM 6) |
| AI | Official OpenAI Node SDK, **Responses API** with Zod structured output; `text-embedding-3-small` embeddings |
| Auth | Auth.js (next-auth v5) with **Microsoft Entra ID**; roles: Administrator, Clinical Reviewer, Read-Only |
| Files | ExcelJS, PapaParse, unpdf (PDF text), SHA-256 duplicate detection |
| Background jobs | Postgres-backed job queue processed in time-boxed ticks (serverless-compatible) |

**Hosting model:**

- **Local:** the app runs on the host with `npm run dev` at <http://localhost:3000>. **Docker Compose runs only the database** (`pgvector/pgvector:0.8.1-pg17`, bound to `127.0.0.1`).
- **Production:** Vercel, with an *approved* hosted PostgreSQL that has pgvector.

**Background processing without a worker server.** Jobs (`ProcessingJob` / `JobItem`) live in Postgres. A *tick* takes a database lease, processes items until its time budget is used, then releases the lease. Ticks are triggered by:

1. `after()` when a job is created, which calls `/api/cron/process-jobs` (CRON_SECRET bearer token).
2. Self-chaining while work remains, giving each invocation a fresh time budget.
3. **Vercel Cron** every minute (`vercel.json`) as a safety net.
4. `npm run worker` locally, as an optional in-process loop.

Processing never depends on a browser tab staying open. Interrupted jobs resume from the next pending item.

**File storage.** Vercel has no persistent filesystem, so uploaded files are stored in Postgres (`SourceFile.content`). Browsers upload in 3 MB chunks to stay under Vercel's 4.5 MB request-body limit. Files are never written to the image or to Git.

---

## Quick start (local)

Prerequisites: Node.js 22+, Docker Desktop.

```bash
cp .env.example .env            # then set POSTGRES_PASSWORD (and the same value in DATABASE_URL), AUTH_SECRET, CRON_SECRET
                                # for local synthetic work also set AUTH_DEV_LOGIN_ENABLED=true
npm install                     # also runs `prisma generate`
docker compose up -d            # starts ONLY the Postgres/pgvector container
docker compose ps               # db should be "healthy"
npm run db:migrate              # prisma migrate deploy (creates the vector + pg_trgm extensions, tables, indexes)
npm run seed:synthetic          # optional: synthetic patients/notes/labels + tests/fixtures CSVs
npm run dev                     # http://localhost:3000
npm run worker                  # optional, in another terminal: local job loop (in addition to after()/self-chaining)
```

Stop the database with `docker compose down`. Data persists in the `postgres_data` volume. `docker compose down -v` deletes it.

Production build check: `npm run build && npm run start`.

> Migrations: `npm run db:migrate` is the single, explicit migration step. Run it once per deployment before serving traffic. The app never migrates on startup, so processes cannot race. The `vector` extension is created by the first migration and needs a role with `CREATE` on the database. The Compose `POSTGRES_USER` is the database owner, which is sufficient. On managed Postgres, enable `vector` and `pg_trgm` or grant the privilege.

---

## Environment variables

See [.env.example](.env.example) for the full annotated list.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Prisma connection. Local: `postgresql://…@127.0.0.1:5432/…`. **URL-encode** special characters in the password. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Used by `docker-compose.yml` for the local db container |
| `AUTH_SECRET`, `AUTH_URL` | Auth.js session signing / canonical URL |
| `AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` / `_ISSUER` | Entra app registration (`https://login.microsoftonline.com/<tenant>/v2.0`) |
| `ENTRA_ROLE_MAP` | JSON map of Entra app-role values to `ADMIN`, `REVIEWER`, `READ_ONLY` (default `STS.Admin`, `STS.Reviewer`, `STS.ReadOnly`) |
| `INITIAL_ADMIN_EMAILS` | Bootstrap admins when no role claim is present |
| `SESSION_MAX_AGE_SECONDS` | Session expiry (default 8 h) |
| `AUTH_DEV_LOGIN_ENABLED` | Local role-picker login. **Refused** when `APP_ENV=production` or PHI approval is on. |
| `OPENAI_API_KEY` | Server-side only; never sent to the browser |
| `OPENAI_PRIMARY_MODEL` / `OPENAI_ESCALATION_MODEL` | Default `gpt-6-luna` / `gpt-6.1-sol`. These are **requested, unverified IDs** (see below). |
| `OPENAI_EMBEDDING_MODEL` | Default `text-embedding-3-small` (1536-d vectors) |
| `OPENAI_REASONING_EFFORT` / `OPENAI_ESCALATION_REASONING_EFFORT` | Default `low` / `medium` |
| `PHI_EXTERNAL_AI_APPROVED` | **Keep `false`** until approvals are in place. While false, only datasets classified `SYNTHETIC` can be sent to OpenAI. |
| `CRON_SECRET` | Bearer secret for `/api/cron/process-jobs` (Vercel Cron sends it automatically) |
| `MAX_UPLOAD_MB` | Upload size cap (default 100) |
| `MALWARE_SCAN_REQUIRED` | If `true`, uploads are refused until an institutional scanner is integrated in `src/lib/storage.ts` |

---

## Importing data

**Through the UI (Upload Data):**

1. Drag and drop a `.xlsx` or `.csv` file.
2. Choose the dataset type and data classification (`SYNTHETIC`, `DEIDENTIFIED` or `PHI`).
3. Pick the worksheet and confirm or adjust the column mapping. Mapping works even when headers differ from the defaults.
4. Read the import report:
   - total, valid, invalid and duplicate rows
   - unique patients and encounters
   - notes per encounter
   - missing identifiers, blank notes, and rows needing attention
5. Import.

Invalid and duplicate rows are **kept** as `SourceRow` records and reported. They are never silently dropped.

**Identifier handling.** MRN, CSN and NOTE_ID are stored as text exactly as received, so leading zeros are preserved. `NOTE_ID` is *not* unique in the source extract: the provided SampleNotes has 723 distinct NOTE_IDs across 1,134 rows, with 387 exact duplicates and 24 IDs that have more than one text version. Notes are therefore keyed on encounter + NOTE_ID + SHA-256 of the text. Literal `NULL` cells are treated as missing. A provisional surgery date is derived from the earliest Op Note / Brief Op Note and flagged `derived — confirm` until a reviewer confirms it.

**Provided reference files (CLI, local only):**

```bash
# Put the files in ./reference-data/ (git-ignored). Then:
npm run inspect:reference       # structure-only report: headers, counts, identifier formats; no PHI printed
npm run import:reference        # imports SampleNotes.xlsx ("INTERNAL 2 CSN") + Complications.xlsx as PHI into the LOCAL db
npm run validate:historical     # re-runs local evidence mapping; prints a PHI-free summary
```

The CLI makes **no network calls**. It classifies data as `PHI` by default, so the PHI gate blocks external AI processing of these files.

---

## Loading the STS manual

The STS CHSD Training Manual (`2026-07_CHSD TM Version 6.23.2.pdf`) **has not been supplied**. Until an approved manual is loaded, STS-based classification is disabled everywhere: a UI banner shows it, the classification gate enforces it, and classification job creation returns 409.

To load it (Administrator, **STS Knowledge Base** page):

1. Upload the PDF, enter its version label, and optionally an effective surgery-date window.
2. A background job extracts text per page and runs an **identity check**. The document must identify itself as an STS *Congenital Heart Surgery* Database training manual or data specification. Other documents, such as the Qlik/Talend order form included with this request, are rejected and never indexed.
3. The manual is chunked by **field blocks** (Long Name / Short Name / Seq # / Table / Definition / Intent-Clarification / codes) and by section headings, so a definition always stays with its clarification. Page numbers and sections are kept, and coded values become code-level rules used for code validation.
4. If `OPENAI_API_KEY` is set, rule chunks are embedded once per manual version. Only manual text is embedded, never patient data. Otherwise retrieval uses keyword search only.
5. An administrator reviews the parse statistics, spot-checks rules in the rule browser, and clicks **Approve**, confirming identity. Approving or retiring a manual invalidates cached classifications.

Multiple manual versions are supported. The version is chosen per encounter from the surgery date and each manual's effective window, falling back to the default version. How the manual was selected is recorded with each run.

> The parser's field layout is based on the STS data-specification format and has **not** been verified against v6.23.2 itself. Review the parse statistics and rule browser before approving.

---

## AI processing

For each encounter (`src/lib/ai/classifier.ts`):

1. **Note preparation:** chronological order, exact-duplicate removal, overlapping semantic passages.
2. **Candidate discovery:** passages are ranked using a clinical vocabulary and negation/assertion screening. Keywords are search guidance only, never proof. Encounters with no candidate passages are not sent to the model.
3. **Rule retrieval:** hybrid search (Postgres full-text + pgvector cosine, combined by reciprocal-rank fusion) restricted to the selected manual version.
4. **Example retrieval:** only clinician-**VERIFIED** examples from the active library. Examples from the same patient and from held-out or test cohorts are excluded.
5. **Model call:** Responses API structured output with `store: false`. The prompt contains **no MRN, CSN or NOTE_ID**. The model refers to passages and rules only by labels (`P3`, `R2`).
6. **Independent validation** (`response-validator.ts`):
   - Every evidence excerpt must appear verbatim in the cited passage, and its offsets are mapped back to the note.
   - Rule references must be among the retrieved rules.
   - STS codes must exist in the indexed manual. Invented codes are removed.
   - Unsupported "confirmed" events are downgraded to insufficient evidence.
   - Negated, historical, planned and out-of-window events are stored as EXCLUDED and shown collapsed.
   - Duplicate events across notes are merged.
   - **Nothing is ever auto-approved.**
7. **Escalation** to the escalation model on validation failure, conflicting evidence, a complex multi-event timeline, a high-risk label, a model flag or a reviewer's "Second opinion" request, subject to the escalation-rate cap.
8. **Persistence** with model, prompt, manual and example-library versions. Earlier unreviewed AI predictions are superseded and kept. Reviewed predictions are never modified.

**Cost controls (Settings):**

- Limits: job token budget, per-encounter cost, escalation-rate cap, retry limit and daily cost limit. A job that hits a limit pauses and can be resumed.
- Per-model prices are **entered by an administrator**, because none are assumed. Without them, cost shows as "price not configured".
- Every call records input, cached and output tokens, reasoning tokens, duration, retries, outcome and cost.
- Identical inputs and configuration reuse the **SHA-256 cache**. The cache key covers note hashes, models, reasoning effort, prompt version, manual version, retrieval settings, library version and output schema.

**Model IDs.** `gpt-6-luna` and `gpt-6.1-sol` are configuration defaults from the specification. They have **not** been verified to exist or to support `reasoning.effort` or structured outputs. Use **Settings → Verify models** (`models.retrieve`). If a model is unavailable, calls fail visibly. The app never silently substitutes a different model.

---

## Review, export and continuous learning

**Patient Search** supports partial matching on MRN, CSN and NOTE_ID, plus filters for Date of Service, complication and status. Filters and page live in the URL, so returning from an encounter keeps your place. Search results never show note text.

**Review screen** (three panels):

- **Notes:** searchable note viewer with evidence highlighting, and switching between notes in the encounter.
- **AI suggestions:**
  - Cards show the STS code, the evidence (click to jump to the note), the explanation, a link to the manual section and page, and similar verified examples.
  - Incomplete evidence is flagged explicitly.
  - Confidence is labelled as self-reported and **uncalibrated**.
- **Decision panel:** Approve, Reject, Correct, Needs further review, comments, and Add missing complication. A corrected STS code must exist in the manual.
  - Decisions are **append-only**: history is shown and every decision is audited.
  - Optimistic concurrency prevents silently overwriting another reviewer's decision.
  - Previous/Next record navigation is included.

**Exports** (Complication Review page; Reviewer or Admin; audited):

- `OutputComplication_YYYYMMDD_HHMMSS.csv` / `.xlsx`: one row per complication, including suggestions.
- `…_NoteLevel.csv` / `.xlsx`: the original input rows with review columns appended.
- "Final Approved Complication" is a separate column from the unreviewed AI suggestion.
- Cells are protected against formula injection, and identifiers are written as text.

**Continuous learning (controlled):**

1. When a reviewer approves or corrects a prediction, a *candidate* example is created.
2. A clinician must **Verify** it (Historical Validation) before it enters the verified library.
3. Each verification creates a new **library version**. Administrators can roll back to any earlier version, and likewise to any earlier **prompt version** (Settings).

No model fine-tuning happens. OpenAI's models are not retrained.

---

## Historical validation

The **Historical Validation** page compares AI predictions with `Complications.xlsx`. It reports precision, recall, F1, per-label sensitivity, false-positive and false-negative rates, exact-match multi-label accuracy and evidence-citation accuracy, with a row-level result for each label: correct, false positive, false negative, incorrect classification, unreviewed or uncertain.

- **Labels:** historical labels are kept exactly as provided. An administrator **label map** (Settings) relates them to canonical STS names for scoring.
- **Evidence mapping:** each label is joined on MRN + CSN + Date of Service to find *candidate* notes, then evidence is located using the Key Words / Note Info columns and assertion screening.
  - Labels are never auto-verified.
  - Labels with only negated mentions are marked `CONFLICTING_EVIDENCE`.
  - All 12 provided labels currently have candidate evidence and are `PENDING_VERIFICATION`.
- **Leakage controls:** cohorts are assigned **per patient**, so a patient's notes are never split. Held-out labels are never retrievable as examples.
- **Model comparison:** runs the primary and escalation models on the same cohort without saving predictions.

> The historical set covers **2 patients and 12 labels**. These metrics are development diagnostics, not evidence of clinical performance. An independent, clinically reviewed test cohort (`INDEPENDENT_TEST`) is required.

---

## Security and PHI safeguards

**Implemented:**

- **Access control:** Entra ID SSO, with role checks on **every** API route (`requireRole`) and page (`requirePageRole`). The UI hiding a control is never relied on.
  - Roles are re-read from the database on every request, and deactivated users are refused.
  - Sessions are JWTs with a configurable expiry.
- **Audit log:** sign-in, encounter and note views, uploads, imports, reviews, exports, job actions and configuration changes.
- **PHI gate:**
  - Non-synthetic data is never sent to OpenAI unless `PHI_EXTERNAL_AI_APPROVED=true`.
  - Classification also requires an approved manual.
  - Seed scripts and tests never call external services; tests mock OpenAI.
- **PHI-safe logging:** an allow-listed metadata logger that scrubs identifiers and emails. There are no third-party error trackers, analytics, web fonts or CDNs, and the CSP restricts connections to `self`.
- **Uploads:** content-signature validation, a size cap and a malware-scan hook.
- **Exports:** formula-injection neutralization.
- **Hardening:** security headers (CSP, HSTS, frame-deny, no-referrer), `store: false` on Responses API calls, and the OpenAI key used server-side only.
- **Git hygiene:** `reference-data/`, uploads, exports and `.env*` are git-ignored.

**Required before any real PHI is processed (institutional prerequisites):**

1. An executed **OpenAI BAA**, with the API organization's zero/limited data-retention configuration confirmed and every endpoint used (Responses, Embeddings) confirmed as eligible.
2. A **Vercel** BAA (or another approved host) and an approved **database** provider BAA, with hosting regions, network controls, encryption at rest and backups approved.
3. **Children's Nebraska security and compliance approval** of the whole data flow.
4. Malware scanning, retention/deletion policy, backup/disaster-recovery and access-review procedures defined and implemented.
5. Entra app registration with app roles, and dev login disabled (`AUTH_DEV_LOGIN_ENABLED=false`, `APP_ENV=production`).

Do not use live PHI in GitHub, Copilot prompts, or any unapproved tool.

---

## Deploying to Vercel

1. Provision an **approved** PostgreSQL with `vector` and `pg_trgm` available, then run `npm run db:migrate` against it from CI or a trusted machine.
2. Set every environment variable in Vercel Project Settings: `APP_ENV=production`, `AUTH_URL` set to your domain, the Entra variables, `CRON_SECRET`, the OpenAI variables, and `PHI_EXTERNAL_AI_APPROVED` (only after approval).
3. `vercel.json` schedules `/api/cron/process-jobs` every minute. Per-minute cron requires a paid Vercel plan; on Hobby, jobs still run through `after()` self-chaining.
4. Long-running routes declare `maxDuration` (≤ 300 s). Enable Fluid Compute or raise the plan limits if needed.
5. If Deployment Protection is on, set `VERCEL_AUTOMATION_BYPASS_SECRET` so job self-chaining can reach the API.

---

## Testing

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run format:check     # prettier
npm test                 # vitest: unit + integration (integration uses an isolated <db>_test database, auto-created and migrated)
npm run test:e2e         # playwright (needs db running, AUTH_DEV_LOGIN_ENABLED=true, `npm run seed:synthetic`, `npm run build`)
```

Coverage:

- Spreadsheet import, column validation and mapping, identifier preservation
- Multi-note encounter mapping and deduplication
- Assertion detection and historical evidence mapping
- Multi-label classification with a mocked OpenAI client
- Evidence linking and verbatim verification; invented-code removal and other false-positive safeguards
- Escalation, retries, budget pause and resume, job leases
- Manual identity check and rule parsing (synthetic fixture text)
- Review decisions and append-only audit history
- Library snapshots
- Export integrity
- Authentication and authorization (401/403, role re-read, deactivation)
- PHI-safe error responses

All test data is synthetic. `src/lib/data/synthetic.ts` generates it, and the fixture manual uses made-up codes, not STS content.

---

## Project structure

```
docker-compose.yml        # local Postgres/pgvector only
vercel.json               # cron for the job pump
prisma/                   # schema + migrations (vector, hnsw, full-text, trigram indexes)
reference-data/           # git-ignored local clinical files (.gitkeep only in Git)
scripts/                  # inspect/import reference data, synthetic seed, historical validation, local worker
src/
  proxy.ts                # optimistic sign-in redirect (real authz is server-side)
  app/(auth)/sign-in      # Entra / dev login
  app/(dashboard)/…       # dashboard, upload, processing, patients, patients/[id], review, validation, knowledge-base, performance, settings
  app/api/…               # upload (chunked), jobs, cron, classifications, patients, reviews, exports, knowledge-base, validation, admin, health
  components/             # ui (shadcn), layout, charts, upload, processing, patients, review, validation, knowledge-base, settings
  lib/ai/                 # openai-client, prompts, classifier, candidate-detection, evidence-retrieval, sts-rules, embeddings, model-router, response-validator, cost-tracker
  lib/data/               # excel/csv readers, normalization, column mapping, import validator/service, record matcher, evidence mapper, synthetic data
  lib/sts/                # pdf-parser (+identity check), rule-parser, manual-indexer, code-validator
  lib/jobs/               # DB-backed queue runner + handlers
  lib/review/             # review decisions, example library, prompt/library versioning
  lib/validation/         # metrics, historical comparison, historical prep
  lib/auth/, lib/security/, lib/export/, lib/patients/
tests/unit, tests/integration, tests/e2e
```

---

## Known limitations and unverified assumptions

- **No STS manual is loaded**, so end-to-end classification against real STS rules has not been run. The rule parser is untested on v6.23.2.
- **The OpenAI model IDs, reasoning-effort support and structured-output support are unverified.** Classification was tested only with a mocked client.
- The clinical vocabulary and negation heuristics only prioritize passages. They are not validated clinical NLP.
- Surgery dates are derived heuristically and must be confirmed by a reviewer, because they select the manual version.
- Admission and discharge dates are not in the source extracts and can be entered manually only.
- Self-reported model confidence is **not calibrated**.
- The historical reference set (2 patients) cannot establish accuracy.
- No malware scanner is integrated; the hook refuses uploads when scanning is required.
- Backup, disaster recovery and retention/deletion procedures are institutional responsibilities and are not implemented here.
