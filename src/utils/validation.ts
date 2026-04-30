import { ApiError } from "./errors";
import type { StartRunRequest, TestCase } from "../models/types";
import { validateTestCaseArray, validateTestCaseRecord } from "./validation/run-payload-schema";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const REQUEST_TOP_LEVEL_KEYS = new Set(["idempotencyKey", "testCases", "datasetPath"]);

const assertTopLevelKeys = (payload: Record<string, unknown>): void => {
  for (const key of Object.keys(payload)) {
    if (!REQUEST_TOP_LEVEL_KEYS.has(key)) {
      throw new ApiError(400, "Invalid input", `Unknown property "${key}"`);
    }
  }
};

const assertString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "Invalid input", `${path} must be a non-empty string`);
  }

  return value;
};

export const validateStartRunRequest = (
  payload: unknown
): { testCases?: TestCase[]; datasetPath?: string; idempotencyKey?: string } => {
  if (!isRecord(payload)) {
    throw new ApiError(400, "Invalid input", "Request body must be an object");
  }

  assertTopLevelKeys(payload);

  const request = payload as StartRunRequest;

  const hasTestCases = Array.isArray(request.testCases);
  const hasDatasetPath = typeof request.datasetPath === "string" && request.datasetPath.trim().length > 0;

  if (!hasTestCases && !hasDatasetPath) {
    throw new ApiError(400, "Invalid input", "Provide testCases or datasetPath");
  }

  const idempotencyKey =
    request.idempotencyKey === undefined
      ? undefined
      : assertString(request.idempotencyKey, "idempotencyKey");

  if (hasTestCases) {
    const parsed = validateTestCaseArray(request.testCases, "testCases");
    return { testCases: parsed, idempotencyKey };
  }

  return {
    datasetPath: assertString(request.datasetPath, "datasetPath"),
    idempotencyKey
  };
};

/** Validates one row from a dataset JSON file (same rules as inline testCases). */
export const validateDatasetTestCaseItem = (item: unknown, index: number): TestCase => {
  return validateTestCaseRecord(item, `dataset[${index}]`);
};
