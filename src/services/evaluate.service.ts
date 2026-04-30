import type { EvaluationResult } from "../models/types";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const flatten = (value: unknown, basePath: string): Map<string, unknown> => {
  const map = new Map<string, unknown>();

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const path = `${basePath}[${index}]`;
      if (isRecord(item) || Array.isArray(item)) {
        const nested = flatten(item, path);
        nested.forEach((nestedValue, nestedPath) => map.set(nestedPath, nestedValue));
      } else {
        map.set(path, item);
      }
    });

    return map;
  }

  if (isRecord(value)) {
    Object.entries(value).forEach(([key, nestedValue]) => {
      const path = basePath ? `${basePath}.${key}` : key;
      if (isRecord(nestedValue) || Array.isArray(nestedValue)) {
        const nested = flatten(nestedValue, path);
        nested.forEach((item, itemPath) => map.set(itemPath, item));
      } else {
        map.set(path, nestedValue);
      }
    });

    return map;
  }

  if (basePath) {
    map.set(basePath, value);
  }

  return map;
};

/**
 * Field-level score (0..1) from flattened leaf paths in prediction vs ground truth.
 *
 * Rules (all use the same flattened path keys as missingFields / extraFields / mismatchedFields):
 *
 * 1. missingFields — path in gold, absent in prediction → counts as one error.
 * 2. mismatchedFields — path in both, JSON-serialized value differs → one error each.
 * 3. extraFields — path in prediction, absent in gold → one error each.
 *
 * Denominator: |E ∪ P| = |expected| + |extraFields|, i.e. gold leaf paths plus prediction-only
 * paths. Equivalently, every leaf path that appears in either tree is one "slot"; we subtract one
 * per error above. So extras reduce the score, and the score is 1 only when there are zero
 * missing, zero mismatched, and zero extra paths.
 *
 * score = max(0, 1 - errorCount / unionSize), with unionSize = 0 treated as perfect (1.0).
 */
const computeScore = (
  expectedSize: number,
  missingCount: number,
  mismatchedCount: number,
  extraCount: number
): number => {
  const errorCount = missingCount + mismatchedCount + extraCount;
  const unionSize = expectedSize + extraCount;

  if (unionSize === 0) {
    return 1;
  }

  const raw = 1 - errorCount / unionSize;
  return Number.parseFloat(Math.max(0, Math.min(1, raw)).toFixed(4));
};

export const evaluateCase = (
  prediction: Record<string, unknown>,
  groundTruth: Record<string, unknown>
): EvaluationResult => {
  const predicted = flatten(prediction, "");
  const expected = flatten(groundTruth, "");

  const missingFields: string[] = [];
  const extraFields: string[] = [];
  const mismatchedFields: Array<{ path: string; expected: unknown; actual: unknown }> = [];

  expected.forEach((expectedValue, path) => {
    if (!predicted.has(path)) {
      missingFields.push(path);
      return;
    }

    const predictedValue = predicted.get(path);
    if (JSON.stringify(predictedValue) !== JSON.stringify(expectedValue)) {
      mismatchedFields.push({
        path,
        expected: expectedValue,
        actual: predictedValue
      });
    }
  });

  predicted.forEach((_value, path) => {
    if (!expected.has(path)) {
      extraFields.push(path);
    }
  });

  const score = computeScore(
    expected.size,
    missingFields.length,
    mismatchedFields.length,
    extraFields.length
  );

  return {
    score,
    missingFields,
    extraFields,
    mismatchedFields
  };
};
