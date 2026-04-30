import { resolve } from "node:path";
import { ApiError } from "../utils/errors";
import { hashIdempotencyPayload } from "../utils/idempotency-payload";
import { makeRunId } from "../utils/hash";
import { validateDatasetTestCaseItem } from "../utils/validation";
import type { CaseResult, RunRecord, RunSummary, TestCase } from "../models/types";
import { FileStore } from "../storage/fileStore";
import { evaluateCase } from "./evaluate.service";
import { processCase, simulateTokenUsage } from "./process.service";

interface StartRunInput {
  testCases?: TestCase[];
  datasetPath?: string;
  idempotencyKey?: string;
}

export interface RunServiceOptions {
  /**
   * Test / demo hook: after this many cases have been persisted in the current
   * `processRunInternal` invocation, stop and leave the run `running` so a later
   * process can resume. Only triggers when more cases remain (`n < totalCases`).
   */
  stopAfterPersistedCaseCount?: number;
}

export class RunService {
  private activeRuns = new Map<string, Promise<void>>();

  constructor(
    private readonly store: FileStore,
    private readonly options: RunServiceOptions = {}
  ) {}

  async resumeIncompleteRuns(): Promise<void> {
    const state = await this.store.readState();
    const resumable = Object.values(state.runs).filter(
      (run) => run.status === "queued" || run.status === "running"
    );

    for (const run of resumable) {
      this.processRun(run.id);
    }
  }

  /**
   * Wait until all in-flight work for `runId` finishes (used in tests to avoid races).
   */
  async waitForRunIdle(runId: string): Promise<void> {
    const pending = this.activeRuns.get(runId);
    if (pending) {
      await pending;
    }
  }

  async startRun(input: StartRunInput): Promise<{ runId: string; reused: boolean }> {
    const payloadHash = hashIdempotencyPayload({
      testCases: input.testCases,
      datasetPath: input.datasetPath
    });

    if (input.idempotencyKey) {
      const existingRunId = await this.resolveIdempotencyKey(input.idempotencyKey, payloadHash);
      if (existingRunId) {
        return { runId: existingRunId, reused: true };
      }
    }

    const datasetCases = input.datasetPath ? await this.loadDataset(input.datasetPath) : undefined;
    const testCases = input.testCases ?? datasetCases;

    if (!testCases || testCases.length === 0) {
      throw new ApiError(400, "Invalid input", "No test cases supplied");
    }

    const runId = makeRunId();
    const now = new Date().toISOString();

    const run: RunRecord = {
      id: runId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      totalCases: testCases.length,
      completedCases: 0,
      totalCostUsd: 0,
      testCases,
      results: {}
    };

    await this.store.updateState((state) => {
      state.runs[runId] = run;
      if (input.idempotencyKey) {
        state.idempotency[input.idempotencyKey] = { runId, payloadHash };
      }
    });

    this.processRun(runId);
    return { runId, reused: false };
  }

  async getRun(runId: string): Promise<RunRecord> {
    const state = await this.store.readState();
    const run = state.runs[runId];
    if (!run) {
      throw new ApiError(404, "Run not found", `run_id ${runId} does not exist`);
    }

    return run;
  }

  async getRunSummary(runId: string): Promise<RunSummary> {
    const run = await this.getRun(runId);
    return {
      runId: run.id,
      status: run.status,
      totalCases: run.totalCases,
      completedCases: run.completedCases,
      totalCostUsd: run.totalCostUsd
    };
  }

  private async loadDataset(datasetPath: string): Promise<TestCase[]> {
    const resolvedPath = resolve(datasetPath);
    let content: string;

    try {
      content = await Bun.file(resolvedPath).text();
    } catch {
      throw new ApiError(400, "Invalid input", `Unable to read dataset at ${datasetPath}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ApiError(400, "Invalid input", "Dataset file must contain valid JSON");
    }

    if (!Array.isArray(parsed)) {
      throw new ApiError(400, "Invalid input", "Dataset must be an array of test cases");
    }

    if (parsed.length === 0) {
      throw new ApiError(400, "Invalid input", "Dataset cannot be empty");
    }

    return parsed.map((item, index) => validateDatasetTestCaseItem(item, index));
  }

  /**
   * Returns existing run id to reuse, or null if this key is free.
   * Legacy entries (payloadHash "") adopt the first seen hash after upgrade.
   */
  private async resolveIdempotencyKey(key: string, payloadHash: string): Promise<string | null> {
    const state = await this.store.readState();
    const entry = state.idempotency[key];

    if (!entry) {
      return null;
    }

    if (entry.payloadHash === payloadHash) {
      return entry.runId;
    }

    if (entry.payloadHash === "") {
      await this.store.updateState((mutable) => {
        const current = mutable.idempotency[key];
        if (current?.payloadHash === "") {
          current.payloadHash = payloadHash;
        }
      });
      return entry.runId;
    }

    throw new ApiError(409, "Idempotency key conflict", "Payload differs from original request");
  }

  private processRun(runId: string): void {
    if (this.activeRuns.has(runId)) {
      return;
    }

    const execution = this.processRunInternal(runId).finally(() => {
      this.activeRuns.delete(runId);
    });

    this.activeRuns.set(runId, execution);
  }

  /**
   * Processes cases sequentially. Each case is written to disk in its own `updateState`
   * before moving on, so a crash or second process can resume without redoing completed
   * cases (`results[caseId]` is the idempotency guard inside the persist transaction).
   */
  private async processRunInternal(runId: string): Promise<void> {
    await this.store.updateState((state) => {
      const run = state.runs[runId];
      if (!run) {
        return;
      }

      if (run.status === "completed") {
        return;
      }

      run.status = "running";
      run.updatedAt = new Date().toISOString();
    });

    const state = await this.store.readState();
    const run = state.runs[runId];
    if (!run || run.status === "completed") {
      return;
    }

    for (const testCase of run.testCases) {
      const currentState = await this.store.readState();
      const currentRun = currentState.runs[runId];
      if (!currentRun) {
        return;
      }

      if (currentRun.results[testCase.id]) {
        continue;
      }

      // True when any case was already persisted for this run before this case runs
      // (continuation after partial progress, including after a new process loads storage).
      const resumedFromPreviousAttempt = Object.keys(currentRun.results).length > 0;

      const startedAt = Date.now();
      const prediction = processCase(testCase.input);
      const evaluation = evaluateCase(prediction, testCase.groundTruth);
      const tokenUsage = simulateTokenUsage(testCase.input, prediction);

      const result: CaseResult = {
        caseId: testCase.id,
        input: testCase.input,
        prediction,
        groundTruth: testCase.groundTruth,
        evaluation,
        trace: {
          steps: [
            "Loaded test case",
            "Generated deterministic structured prediction",
            "Compared prediction with ground truth",
            "Persisted result"
          ],
          processingMs: Date.now() - startedAt,
          resumedFromPreviousAttempt
        },
        tokenUsage,
        completedAt: new Date().toISOString()
      };

      await this.store.updateState((mutableState) => {
        const mutableRun = mutableState.runs[runId];
        if (!mutableRun || mutableRun.results[testCase.id]) {
          return;
        }

        mutableRun.results[testCase.id] = result;
        mutableRun.completedCases = Object.keys(mutableRun.results).length;
        mutableRun.totalCostUsd = Number.parseFloat(
          Object.values(mutableRun.results)
            .reduce((sum, item) => sum + item.tokenUsage.costUsd, 0)
            .toFixed(6)
        );
        mutableRun.updatedAt = new Date().toISOString();
      });

      const cap = this.options.stopAfterPersistedCaseCount;
      if (cap !== undefined) {
        const snap = await this.store.readState();
        const r = snap.runs[runId];
        const persisted = r ? Object.keys(r.results).length : 0;
        if (r && persisted >= cap && persisted < r.totalCases) {
          return;
        }
      }
    }

    await this.store.updateState((finalState) => {
      const finalRun = finalState.runs[runId];
      if (!finalRun) {
        return;
      }

      if (finalRun.completedCases >= finalRun.totalCases) {
        finalRun.status = "completed";
      }

      finalRun.updatedAt = new Date().toISOString();
    });
  }
}
