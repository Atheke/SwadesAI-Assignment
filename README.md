# Clinical evaluation API

HTTP API for running **evaluation jobs** on conversational **test cases**: each case supplies transcript text and structured **ground truth**. The service produces a deterministic structured **prediction**, compares it to gold, persists **per-case and run-level metrics**, and tracks **runs** (status, cost, resumability).

Stack: **Bun**, **TypeScript**. Persistence: JSON file under `storage-data/` (configurable via app wiring; default `storage-data/runs.json`).

---

## Requirements

- [Bun](https://bun.sh) installed locally

---

## Run with Bun

```bash
# Install dependencies
bun install

# Development (watch mode)
bun run dev

# Production-style (no watch)
bun start
```

The server listens on **`http://localhost:3000`** unless you set **`PORT`** (e.g. `PORT=8080 bun run dev`).

```bash
# Tests
bun test
```

---

## Idempotency

`POST /run` accepts an optional **`idempotencyKey`**.

- **Same key + same payload** → **HTTP 200**, `reused: true`, same `run_id` as the original run. No duplicate work.
- **Same key + different payload** → **HTTP 409** with a clear error body (see [Errors](#errors)). This prevents accidentally reusing a client key for a different job.
- The server stores a **SHA-256** hash of a **canonical payload**: inline runs use `testCases` sorted by `id` and recursively sorted keys inside `groundTruth`; dataset runs hash the trimmed **`datasetPath` string** (file contents are not hashed).
- Persisted mappings survive restarts. Older storage rows that only stored a run id without a hash are normalized on load; the first repeat request after upgrade records the hash for that key.

---

## Evaluation scoring

Predictions and ground truth are compared on **flattened leaf paths** (e.g. `vitals.bp`, `diagnoses[0].description`).

For each case the API reports:

| Field | Meaning |
| --- | --- |
| `missingFields` | Path present in gold, missing in prediction |
| `extraFields` | Path present in prediction, not in gold |
| `mismatchedFields` | Path in both; values differ (`JSON.stringify` equality) |

**Score** (0…1, inclusive):

- **Errors** = `|missing| + |mismatched| + |extra|`
- **Union size** = number of gold leaf paths + number of extra paths (= \(|E \cup P|\) over leaves)
- **score** = `clamp(0, 1, 1 - errors / unionSize)`; if both trees are empty, score = **1**

So **extra** fields lower the score, and **score = 1** only when there are no missing, mismatched, or extra leaf paths. The numeric score is consistent with the reported field lists.

---

## Resumability and run lifecycle

- After **each** case completes, results are written in **one** durable store update before the next case starts.
- On process start, **incomplete** runs (`queued` or `running`) are **resumed**; cases that already have `results[caseId]` are **skipped** (no duplicate processing).
- **`failed`** and **`completed`** runs are **not** resumed.
- Per-case **`trace.resumedFromPreviousAttempt`** is `true` when that case runs after another case was already stored for the same run (including after a restart loading partial state).

| `status` | Meaning |
| --- | --- |
| `queued` | Run created; worker has not committed `running` yet |
| `running` | In progress, or stopped mid-run with partial results |
| `completed` | All cases have persisted results |
| `failed` | Uncaught error during processing; partial results may exist; includes `failedReason` on summary/details |

Allowed transitions: `queued` → `running` → `completed`, or `running` → `failed`. Terminal states are not moved backward to `running`.

---

## Request validation

- Request body must be a JSON **object** with only: `idempotencyKey`, `testCases`, and/or `datasetPath` (plus one of `testCases` or `datasetPath` required as today).
- Each test case allows only **`id`**, **`input`**, **`groundTruth`**. **`groundTruth`** follows a strict clinical-shaped schema (allowlisted keys, nested `vitals` / `medications` / `diagnoses` / `plan` / `follow_up` rules).
- **HTTP 400** — malformed envelope, unknown top-level property, bad `datasetPath` type, etc.
- **HTTP 422** — schema violations (unknown nested keys, wrong types such as a number where a string or `null` is required).

---

## API reference

### `POST /run`

Creates a run and starts processing asynchronously.

**Response:** **201** with `run_id` and `reused: false` for a new run; **200** with `reused: true` when idempotency reuses an existing run.

```bash
curl -sS -X POST "http://localhost:3000/run" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "client-run-001",
    "testCases": [
      {
        "id": "case-1",
        "input": "Chief complaint: cough\nBP: 120/80 HR: 88\nDiagnosis: viral URI\nPlan: rest",
        "groundTruth": {
          "chief_complaint": "cough",
          "vitals": { "bp": "120/80", "hr": "88" },
          "diagnoses": [{ "description": "viral URI" }],
          "plan": ["rest"]
        }
      }
    ]
  }'
```

Dataset-based runs (JSON file = array of the same test-case objects):

```bash
curl -sS -X POST "http://localhost:3000/run" \
  -H "Content-Type: application/json" \
  -d '{"datasetPath": "./data/cases.json"}'
```

Idempotency conflict (different body, same key):

```bash
curl -sS -w "\nHTTP %{http_code}\n" -X POST "http://localhost:3000/run" \
  -H "Content-Type: application/json" \
  -d '{"idempotencyKey":"client-run-001","testCases":[{"id":"x","input":"y","groundTruth":{"chief_complaint":"z"}}]}'
```

### `GET /run/:id`

Run summary: `runId`, `status`, `totalCases`, `completedCases`, `totalCostUsd`. If `status` is `failed`, **`failedReason`** is included.

```bash
RUN_ID="run_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
curl -sS "http://localhost:3000/run/${RUN_ID}"
```

### `GET /run/:id/details`

Full run payload: summary fields, optional **`failedReason`**, and **`cases`** (input, prediction, ground truth, evaluation, trace, token usage).

```bash
curl -sS "http://localhost:3000/run/${RUN_ID}/details"
```

---

## Errors

All error responses use:

```json
{
  "error": "Short label",
  "details": "Human-readable detail, often with a JSON path"
}
```

Examples:

| HTTP | Typical `error` |
| --- | --- |
| 400 | `Invalid input` |
| 404 | `Run not found` |
| 409 | `Idempotency key conflict` |
| 422 | `Validation failed` |

The API layer catches validation and domain errors so malformed clients do not crash the process.

---

## Project layout

```text
src/
  server.ts              # Bun.serve entry
  app.ts                 # Routes + services wiring
  routes/run.routes.ts
  services/
    run.service.ts       # Runs, idempotency, resume, lifecycle
    process.service.ts # Deterministic extraction + simulated tokens/cost
    evaluate.service.ts# Scoring + diffs
  storage/fileStore.ts # JSON persistence + in-process lock
  utils/                 # validation, idempotency hash, errors, etc.
tests/                   # Bun tests
```

---

## Assumptions

- **Extraction** is **deterministic** (rule-based) so runs are reproducible without external model calls.
- **Token and cost** fields are **simulated** from text length, not from a real LLM billing API.
- **Single-node** usage: one process owns the JSON store; scaling out would require shared storage and coordination beyond this repo.

## Trade-offs

| Choice | Benefit | Limitation |
| --- | --- | --- |
| JSON file store | Zero external DB, easy deploy | Not ideal for high write concurrency or multi-writer clusters |
| Strict `groundTruth` schema | Safer API contracts | Clients must shape gold data to the schema |
| In-process run queue | Simple concurrency story | Throughput bounded by one worker pipeline per process |
