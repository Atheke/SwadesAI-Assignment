export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface TestCase {
  id: string;
  input: string;
  groundTruth: Record<string, unknown>;
}

export interface EvaluationResult {
  score: number;
  missingFields: string[];
  extraFields: string[];
  mismatchedFields: Array<{ path: string; expected: unknown; actual: unknown }>;
}

export interface CaseTrace {
  steps: string[];
  processingMs: number;
  resumedFromPreviousAttempt: boolean;
}

export interface CaseTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface CaseResult {
  caseId: string;
  input: string;
  prediction: Record<string, unknown>;
  groundTruth: Record<string, unknown>;
  evaluation: EvaluationResult;
  trace: CaseTrace;
  tokenUsage: CaseTokenUsage;
  completedAt: string;
}

export interface RunRecord {
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  totalCases: number;
  completedCases: number;
  totalCostUsd: number;
  testCases: TestCase[];
  results: Record<string, CaseResult>;
  failedReason?: string;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  totalCases: number;
  completedCases: number;
  totalCostUsd: number;
  /** Present when `status` is `failed` */
  failedReason?: string;
}

export interface IdempotencyEntry {
  runId: string;
  /** SHA-256 hex of canonical idempotency payload; empty string = pre-hash migration / legacy */
  payloadHash: string;
}

export interface PersistedState {
  runs: Record<string, RunRecord>;
  idempotency: Record<string, IdempotencyEntry>;
}

export interface StartRunRequest {
  testCases?: unknown;
  datasetPath?: unknown;
  idempotencyKey?: unknown;
}
