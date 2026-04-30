import { createHash } from "node:crypto";
import type { TestCase } from "../models/types";

const deepSortKeys = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(deepSortKeys);
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = deepSortKeys(record[key]);
  }

  return sorted;
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
};

/**
 * Canonical form for hashing: deterministic JSON shape (sorted object keys, test cases sorted by id).
 * Only the request's testCases or datasetPath participate — not resolved file contents for dataset runs.
 */
export const canonicalizeIdempotencyPayload = (input: {
  testCases?: TestCase[];
  datasetPath?: string;
}): unknown => {
  if (input.testCases && input.testCases.length > 0) {
    const sorted = [...input.testCases].sort((a, b) => a.id.localeCompare(b.id));
    return {
      source: "inline",
      testCases: sorted.map((tc) => ({
        id: tc.id,
        input: tc.input,
        groundTruth: deepSortKeys(tc.groundTruth)
      }))
    };
  }

  if (input.datasetPath !== undefined && input.datasetPath.trim().length > 0) {
    return {
      source: "dataset",
      datasetPath: input.datasetPath.trim()
    };
  }

  return { source: "empty" };
};

export const hashIdempotencyPayload = (input: {
  testCases?: TestCase[];
  datasetPath?: string;
}): string => {
  const canonical = canonicalizeIdempotencyPayload(input);
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
};
