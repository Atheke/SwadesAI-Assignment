import { resolve } from "node:path";
import { ApiError } from "../utils/errors";
import { makeRunId } from "../utils/hash";
import type { CaseResult, RunRecord, RunSummary, TestCase } from "../models/types";
import { FileStore } from "../storage/fileStore";
import { evaluateCase } from "./evaluate.service";
import { processCase, simulateTokenUsage } from "./process.service";

interface StartRunInput {
  testCases?: TestCase[];
  datasetPath?: string;
  idempotencyKey?: string;
}

export class RunService {
  private activeRuns = new Map<string, Promise<void>>();

  constructor(private readonly store: FileStore) {}

  async resumeIncompleteRuns(): Promise<void> {
    const state = await this.store.readState();
    const resumable = Object.values(state.runs).filter(
      (run) => run.status === "queued" || run.status === "running"
    );

    for (const run of resumable) {
      this.processRun(run.id);
    }
  }

  async startRun(input: StartRunInput): Promise<{ runId: string; reused: boolean }> {
    const datasetCases = input.datasetPath ? await this.loadDataset(input.datasetPath) : undefined;
    const testCases = input.testCases ?? datasetCases;

    if (!testCases || testCases.length === 0) {
      throw new ApiError(400, "Invalid input", "No test cases supplied");
    }

    const existingRunId = input.idempotencyKey ? await this.getExistingIdempotentRun(input.idempotencyKey) : null;
    if (existingRunId) {
      return { runId: existingRunId, reused: true };
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
        state.idempotency[input.idempotencyKey] = runId;
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

    return parsed.map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new ApiError(400, "Invalid input", `Dataset item at index ${index} must be an object`);
      }

      const entry = item as Record<string, unknown>;
      if (typeof entry.id !== "string" || typeof entry.input !== "string") {
        throw new ApiError(400, "Invalid input", `Dataset item at index ${index} is missing id/input`);
      }

      if (typeof entry.groundTruth !== "object" || entry.groundTruth === null || Array.isArray(entry.groundTruth)) {
        throw new ApiError(400, "Invalid input", `Dataset item at index ${index} requires groundTruth object`);
      }

      return {
        id: entry.id,
        input: entry.input,
        groundTruth: entry.groundTruth as Record<string, unknown>
      };
    });
  }

  private async getExistingIdempotentRun(key: string): Promise<string | null> {
    const state = await this.store.readState();
    const runId = state.idempotency[key];
    return runId ?? null;
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
          resumedFromPreviousAttempt: currentRun.status === "running" && currentRun.completedCases > 0
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
