import { ApiError } from "./errors";
import type { StartRunRequest, TestCase } from "../models/types";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const assertString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "Invalid input", `${path} must be a non-empty string`);
  }

  return value;
};

const parseSingleTestCase = (raw: unknown, index: number): TestCase => {
  if (!isRecord(raw)) {
    throw new ApiError(400, "Invalid input", `testCases[${index}] must be an object`);
  }

  const id = assertString(raw.id, `testCases[${index}].id`);
  const input = assertString(raw.input, `testCases[${index}].input`);

  if (!isRecord(raw.groundTruth)) {
    throw new ApiError(400, "Invalid input", `testCases[${index}].groundTruth must be an object`);
  }

  return {
    id,
    input,
    groundTruth: raw.groundTruth
  };
};

export const validateStartRunRequest = (
  payload: unknown
): { testCases?: TestCase[]; datasetPath?: string; idempotencyKey?: string } => {
  if (!isRecord(payload)) {
    throw new ApiError(400, "Invalid input", "Request body must be an object");
  }

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
    const parsed = (request.testCases as unknown[]).map(parseSingleTestCase);

    if (parsed.length === 0) {
      throw new ApiError(400, "Invalid input", "testCases cannot be empty");
    }

    return { testCases: parsed, idempotencyKey };
  }

  return {
    datasetPath: assertString(request.datasetPath, "datasetPath"),
    idempotencyKey
  };
};
