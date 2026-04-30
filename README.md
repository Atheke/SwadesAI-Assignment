# Evaluation Backend System (Bun + TypeScript)

Production-style backend system for running deterministic evaluation jobs on medical conversation test cases.

## Overview

This service supports end-to-end evaluation workflows:

- Accepts test cases directly or from a dataset file
- Processes each case into structured output (deterministic mock extractor)
- Evaluates prediction vs ground truth
- Stores case-level and run-level results persistently
- Tracks run status, progress, simulated token usage, and cost
- Supports resumability after restart
- Supports idempotent run creation
- Exposes APIs to inspect run summaries and detailed traces

## Resumability

- After each case finishes, results and progress are written in a single JSON-store update so work is durable before the next case starts.
- On startup, `resumeIncompleteRuns()` picks up runs in `queued` or `running` and continues only cases that do not yet have a `results[caseId]` entry (no duplicate processing).
- Each case’s `trace.resumedFromPreviousAttempt` is `true` when that case is processed after another case was already stored for the same run (including loading partial progress from disk after a restart).
- Tests simulate a crash mid-run with `createApp({ runServiceOptions: { stopAfterPersistedCaseCount: 1 } })`, then a second `createApp` on the same storage file to assert the remaining cases complete and the first case’s `completedAt` is unchanged.

## Architecture

```text
src/
  app.ts                  # App wiring
  server.ts               # Bun HTTP entrypoint
  models/
    types.ts              # Domain interfaces
  routes/
    run.routes.ts         # HTTP route handlers
  services/
    process.service.ts    # Deterministic case processor + token simulation
    evaluate.service.ts   # Prediction vs ground truth evaluator
    run.service.ts        # Run lifecycle, resumability, idempotency
  storage/
    fileStore.ts          # JSON persistence with lock-based safe updates
  utils/
    errors.ts             # API error formatters
    hash.ts               # Run ID generator
    idempotency-payload.ts # Canonical payload + SHA-256 for idempotency
    json.ts               # Safe JSON parser
    validation.ts         # Input validation
tests/
  run.test.ts             # Bun tests for API and run behavior
storage-data/
  .gitkeep
```

## Setup

```bash
bun install
```

## Run

```bash
bun run dev
```

Server starts on `http://localhost:3000`.

## Tests

```bash
bun test
```

## API Documentation

### `POST /run`

Starts a new evaluation run.

Request body:

```json
{
  "testCases": [
    {
      "id": "case-1",
      "input": "Chief complaint: cough ...",
      "groundTruth": {
        "chief_complaint": "cough"
      }
    }
  ],
  "idempotencyKey": "optional-key"
}
```

Or use dataset file path:

```json
{
  "datasetPath": "./my-dataset.json"
}
```

Response:

```json
{
  "run_id": "run_xxx",
  "reused": false
}
```

**Idempotency:** With `idempotencyKey`, the server stores a **SHA-256** of a canonical form of the request payload (inline `testCases` sorted by id with sorted object keys in `groundTruth`, or trimmed `datasetPath` for dataset runs). The same key with the **same** payload returns **HTTP 200** and `reused: true`. The same key with a **different** payload returns **HTTP 409**:

```json
{
  "error": "Idempotency key conflict",
  "details": "Payload differs from original request"
}
```

Older persisted rows that only stored `runId` (no hash) are migrated on read; the first repeat request after upgrade records the hash for that key.

### `GET /run/:id`

Returns run summary:

```json
{
  "runId": "run_xxx",
  "status": "running",
  "totalCases": 10,
  "completedCases": 4,
  "totalCostUsd": 0.000731
}
```

### `GET /run/:id/details`

Returns run with per-case details including:

- input
- prediction
- groundTruth
- evaluation diff (`missingFields`, `extraFields`, `mismatchedFields`)
- trace (`steps`, `processingMs`)
- token usage and per-case cost

## Error Format

Errors return:

```json
{
  "error": "Invalid input",
  "details": "testCases[0].id must be a non-empty string"
}
```

Idempotency conflict (HTTP 409):

```json
{
  "error": "Idempotency key conflict",
  "details": "Payload differs from original request"
}
```

## Assumptions

- `processCase` is deterministic and simple by design (regex/rule-based) for assignment reliability.
- Persistence is local JSON file-based (`storage-data/runs.json`) to keep setup lightweight.
- Concurrency safety is handled by an in-process lock around reads/writes.

## Trade-offs

- JSON file storage is easy to run but not ideal for high-throughput multi-process workloads.
- Deterministic extraction intentionally favors predictability over model realism.
- Run processing is asynchronous in-process; horizontal scaling would require distributed coordination.

## Sample API Calls

Create run:

```bash
curl -X POST http://localhost:3000/run \
  -H 'Content-Type: application/json' \
  -d '{
    "idempotencyKey": "demo-run-1",
    "testCases": [
      {
        "id": "case-1",
        "input": "Chief complaint: cough\\nBP: 120/80 HR: 88 Temp_f: 99.1 SpO2: 97\\nDiagnosis: viral URI\\nPlan: hydration; rest\\nFollow up in 7 days for reassessment",
        "groundTruth": {
          "chief_complaint": "cough",
          "vitals": {"bp": "120/80"}
        }
      }
    ]
  }'
```

Run summary:

```bash
curl http://localhost:3000/run/<run_id>
```

Run details:

```bash
curl http://localhost:3000/run/<run_id>/details
```
