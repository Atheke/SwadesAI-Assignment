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

All errors return:

```json
{
  "error": "Invalid input",
  "details": "testCases[0].id must be a non-empty string"
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
