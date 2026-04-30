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

  const maxFields = Math.max(expected.size, 1);
  const correctFields = maxFields - missingFields.length - mismatchedFields.length;
  const score = Number.parseFloat(Math.max(0, correctFields / maxFields).toFixed(4));

  return {
    score,
    missingFields,
    extraFields,
    mismatchedFields
  };
};
