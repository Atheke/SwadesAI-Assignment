import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

const createdFiles: string[] = [];

const buildStoragePath = (): string => {
  const path = `storage-data/test-${crypto.randomUUID()}.json`;
  createdFiles.push(path);
  return path;
};

const waitForRunCompletion = async (
  fetchFn: (request: Request) => Promise<Response>,
  runId: string,
  timeoutMs = 2000
): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchFn(new Request(`http://localhost/run/${runId}`));
    const body = (await response.json()) as { status: string };
    if (body.status === "completed") {
      return;
    }

    await Bun.sleep(25);
  }

  throw new Error(`Run ${runId} did not complete within timeout`);
};

const waitForSummary = async (
  fetchFn: (request: Request) => Promise<Response>,
  runId: string,
  predicate: (body: { status: string; completedCases: number }) => boolean,
  timeoutMs = 3000
): Promise<{ status: string; completedCases: number }> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchFn(new Request(`http://localhost/run/${runId}`));
    const body = (await response.json()) as { status: string; completedCases: number };
    if (predicate(body)) {
      return body;
    }
    await Bun.sleep(25);
  }

  throw new Error(`Run ${runId} did not reach expected summary within timeout`);
};

const threeCaseTestCases = [
  {
    id: "case-1",
    input: "Chief complaint: cough\nDiagnosis: URI",
    groundTruth: { chief_complaint: "cough", diagnoses: [{ description: "URI" }] }
  },
  {
    id: "case-2",
    input: "Chief complaint: fever\nDiagnosis: flu",
    groundTruth: { chief_complaint: "fever", diagnoses: [{ description: "flu" }] }
  },
  {
    id: "case-3",
    input: "Chief complaint: pain\nDiagnosis: strain",
    groundTruth: { chief_complaint: "pain", diagnoses: [{ description: "strain" }] }
  }
];

const sampleTestCases = [
  {
    id: "case-1",
    input:
      "Chief complaint: cough\nBP: 120/80 HR: 88 Temp_f: 99.1 SpO2: 97\nDiagnosis: viral URI\nPlan: hydration; rest\nFollow up in 7 days for reassessment",
    groundTruth: {
      chief_complaint: "cough",
      vitals: {
        bp: "120/80",
        hr: "88",
        temp_f: "99.1",
        spo2: "97"
      },
      diagnoses: [{ description: "viral URI" }],
      plan: ["hydration", "rest"]
    }
  }
];

afterEach(async () => {
  for (const file of createdFiles.splice(0, createdFiles.length)) {
    await Bun.write(file, "");
  }
});

describe("evaluation run APIs", () => {
  test("creates a run", async () => {
    const app = createApp({ storagePath: buildStoragePath() });

    const response = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCases: sampleTestCases })
      })
    );

    const body = (await response.json()) as { run_id: string };

    expect(response.status).toBe(201);
    expect(body.run_id).toContain("run_");
  });

  test("supports idempotency key", async () => {
    const app = createApp({ storagePath: buildStoragePath() });

    const payload = {
      testCases: sampleTestCases,
      idempotencyKey: "idem-123"
    };

    const first = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
    );

    const second = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
    );

    const firstBody = (await first.json()) as { run_id: string; reused: boolean };
    const secondBody = (await second.json()) as { run_id: string; reused: boolean };

    expect(firstBody.run_id).toBe(secondBody.run_id);
    expect(secondBody.reused).toBeTrue();
    expect(second.status).toBe(200);
  });

  test("idempotency key with different payload returns 409", async () => {
    const app = createApp({ storagePath: buildStoragePath() });
    const key = "idem-conflict";

    const first = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: key,
          testCases: sampleTestCases
        })
      })
    );

    expect(first.status).toBe(201);

    const conflict = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: key,
          testCases: [
            {
              id: "case-2",
              input: "Chief complaint: fever",
              groundTruth: { chief_complaint: "fever" }
            }
          ]
        })
      })
    );

    const body = (await conflict.json()) as { error: string; details: string };
    expect(conflict.status).toBe(409);
    expect(body.error).toBe("Idempotency key conflict");
    expect(body.details).toBe("Payload differs from original request");
  });

  test("idempotency payload hash is stable for key order in groundTruth", async () => {
    const app = createApp({ storagePath: buildStoragePath() });
    const key = "idem-canonical";

    const payloadA = {
      idempotencyKey: key,
      testCases: [
        {
          id: "b",
          input: "x",
          groundTruth: {
            chief_complaint: "bx",
            diagnoses: [{ description: "db" }]
          }
        },
        {
          id: "a",
          input: "y",
          groundTruth: {
            chief_complaint: "ay",
            diagnoses: [{ description: "da" }]
          }
        }
      ]
    };

    const payloadB = {
      idempotencyKey: key,
      testCases: [
        {
          id: "a",
          input: "y",
          groundTruth: {
            diagnoses: [{ description: "da" }],
            chief_complaint: "ay"
          }
        },
        {
          id: "b",
          input: "x",
          groundTruth: {
            diagnoses: [{ description: "db" }],
            chief_complaint: "bx"
          }
        }
      ]
    };

    const first = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadA)
      })
    );

    const second = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadB)
      })
    );

    const firstBody = (await first.json()) as { run_id: string; reused: boolean };
    const secondBody = (await second.json()) as { run_id: string; reused: boolean };

    expect(firstBody.run_id).toBe(secondBody.run_id);
    expect(secondBody.reused).toBeTrue();
    expect(second.status).toBe(200);
  });

  test("returns structured validation errors", async () => {
    const app = createApp({ storagePath: buildStoragePath() });

    const response = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetPath: 42 })
      })
    );

    const body = (await response.json()) as { error: string; details: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid input");
    expect(body.details.length).toBeGreaterThan(0);
  });

  test("rejects unknown top-level property with 400", async () => {
    const app = createApp({ storagePath: buildStoragePath() });
    const response = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCases: threeCaseTestCases,
          extraField: true
        })
      })
    );
    const body = (await response.json()) as { error: string; details: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid input");
    expect(body.details).toContain("Unknown property");
  });

  test("rejects unknown groundTruth property with 422", async () => {
    const app = createApp({ storagePath: buildStoragePath() });
    const response = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCases: [
            {
              id: "c1",
              input: "test",
              groundTruth: {
                chief_complaint: "x",
                unknown_key: 1
              }
            }
          ]
        })
      })
    );
    const body = (await response.json()) as { error: string; details: string };
    expect(response.status).toBe(422);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toContain("unknown or disallowed property");
  });

  test("rejects wrong vitals type with 422", async () => {
    const app = createApp({ storagePath: buildStoragePath() });
    const response = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCases: [
            {
              id: "c1",
              input: "test",
              groundTruth: {
                chief_complaint: "x",
                vitals: { hr: 88 }
              }
            }
          ]
        })
      })
    );
    const body = (await response.json()) as { error: string; details: string };
    expect(response.status).toBe(422);
    expect(body.error).toBe("Validation failed");
    expect(body.details).toContain("vitals.hr");
  });

  test("rejects malformed diagnosis with 422", async () => {
    const app = createApp({ storagePath: buildStoragePath() });
    const response = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testCases: [
            {
              id: "c1",
              input: "test",
              groundTruth: {
                diagnoses: [{ icd10: "J00" }]
              }
            }
          ]
        })
      })
    );
    const body = (await response.json()) as { error: string; details: string };
    expect(response.status).toBe(422);
    expect(body.details).toContain("description");
  });

  test("returns run details endpoint output", async () => {
    const app = createApp({ storagePath: buildStoragePath() });

    const startResponse = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCases: sampleTestCases })
      })
    );

    const startBody = (await startResponse.json()) as { run_id: string };
    await waitForRunCompletion(app.fetch, startBody.run_id);

    const detailsResponse = await app.fetch(
      new Request(`http://localhost/run/${startBody.run_id}/details`)
    );
    const detailsBody = (await detailsResponse.json()) as { cases: Array<{ caseId: string }> };

    expect(detailsResponse.status).toBe(200);
    expect(detailsBody.cases.length).toBe(1);
    expect(detailsBody.cases[0]?.caseId).toBe("case-1");
  });

  test("resumes incomplete run after restart", async () => {
    const storagePath = buildStoragePath();
    const app1 = createApp({ storagePath });

    const start = await app1.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCases: sampleTestCases })
      })
    );

    const body = (await start.json()) as { run_id: string };

    const app2 = createApp({ storagePath });
    await waitForRunCompletion(app2.fetch, body.run_id);

    const summary = await app2.fetch(new Request(`http://localhost/run/${body.run_id}`));
    const summaryBody = (await summary.json()) as { status: string; completedCases: number };

    expect(summaryBody.status).toBe("completed");
    expect(summaryBody.completedCases).toBe(1);
  });

  test("simulated interruption: resumes remaining cases without reprocessing completed", async () => {
    const storagePath = buildStoragePath();
    const app1 = createApp({
      storagePath,
      runServiceOptions: { stopAfterPersistedCaseCount: 1 }
    });

    const start = await app1.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCases: threeCaseTestCases })
      })
    );

    const { run_id: runId } = (await start.json()) as { run_id: string };
    await app1.runService.waitForRunIdle(runId);

    const partial = await waitForSummary(
      app1.fetch,
      runId,
      (s) => s.completedCases === 1 && s.status === "running"
    );
    expect(partial.status).toBe("running");

    const details1 = (await (
      await app1.fetch(new Request(`http://localhost/run/${runId}/details`))
    ).json()) as {
      cases: Array<{ caseId: string; completedAt: string; trace: { resumedFromPreviousAttempt: boolean } }>;
    };

    const case1First = details1.cases.find((c) => c.caseId === "case-1");
    expect(case1First).toBeDefined();
    expect(case1First?.trace.resumedFromPreviousAttempt).toBeFalse();
    const case1CompletedAt = case1First?.completedAt;

    expect(details1.cases.filter((c) => c.caseId === "case-2").length).toBe(0);

    const app2 = createApp({ storagePath });
    await waitForRunCompletion(app2.fetch, runId, 5000);
    await app2.runService.waitForRunIdle(runId);

    const details2 = (await (
      await app2.fetch(new Request(`http://localhost/run/${runId}/details`))
    ).json()) as {
      cases: Array<{ caseId: string; completedAt: string; trace: { resumedFromPreviousAttempt: boolean } }>;
    };

    expect(details2.cases.length).toBe(3);

    const case1After = details2.cases.find((c) => c.caseId === "case-1");
    expect(case1After?.completedAt).toBe(case1CompletedAt);

    const case2 = details2.cases.find((c) => c.caseId === "case-2");
    const case3 = details2.cases.find((c) => c.caseId === "case-3");
    expect(case2?.trace.resumedFromPreviousAttempt).toBeTrue();
    expect(case3?.trace.resumedFromPreviousAttempt).toBeTrue();
  });

  test("failed run exposes status and failedReason on GET /run/:id", async () => {
    const storagePath = buildStoragePath();
    const app = createApp({
      storagePath,
      runServiceOptions: { throwOnCaseId: "case-2" }
    });

    const start = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCases: threeCaseTestCases })
      })
    );

    const { run_id: runId } = (await start.json()) as { run_id: string };
    await app.runService.waitForRunIdle(runId);

    const summaryRes = await app.fetch(new Request(`http://localhost/run/${runId}`));
    const summary = (await summaryRes.json()) as {
      status: string;
      completedCases: number;
      failedReason?: string;
    };

    expect(summary.status).toBe("failed");
    expect(summary.completedCases).toBe(1);
    expect(summary.failedReason).toContain("Simulated failure");

    const detailsRes = await app.fetch(new Request(`http://localhost/run/${runId}/details`));
    const details = (await detailsRes.json()) as {
      status: string;
      failedReason?: string;
      cases: Array<{ caseId: string }>;
    };

    expect(details.status).toBe("failed");
    expect(details.failedReason).toContain("Simulated failure");
    expect(details.cases.length).toBe(1);
    expect(details.cases[0]?.caseId).toBe("case-1");
  });

  test("failed runs are not resumed on a new process", async () => {
    const storagePath = buildStoragePath();
    const app1 = createApp({
      storagePath,
      runServiceOptions: { throwOnCaseId: "case-2" }
    });

    const start = await app1.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCases: threeCaseTestCases })
      })
    );

    const { run_id: runId } = (await start.json()) as { run_id: string };
    await app1.runService.waitForRunIdle(runId);

    const app2 = createApp({ storagePath });
    await app2.runService.waitForRunIdle(runId);

    const summary = (await (await app2.fetch(new Request(`http://localhost/run/${runId}`))).json()) as {
      status: string;
      completedCases: number;
    };

    expect(summary.status).toBe("failed");
    expect(summary.completedCases).toBe(1);
  });
});
