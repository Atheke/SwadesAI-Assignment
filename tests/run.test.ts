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
          groundTruth: { z: 1, a: 2 }
        },
        {
          id: "a",
          input: "y",
          groundTruth: { m: 3 }
        }
      ]
    };

    const payloadB = {
      idempotencyKey: key,
      testCases: [
        {
          id: "a",
          input: "y",
          groundTruth: { m: 3 }
        },
        {
          id: "b",
          input: "x",
          groundTruth: { a: 2, z: 1 }
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
});
