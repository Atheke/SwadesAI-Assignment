import { ApiError } from "../errors";
import type { TestCase } from "../../models/types";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const TEST_CASE_KEYS = new Set(["id", "input", "groundTruth"]);

const GROUND_TRUTH_KEYS = new Set([
  "chief_complaint",
  "vitals",
  "medications",
  "diagnoses",
  "plan",
  "follow_up"
]);

const VITAL_SUBKEYS = new Set(["bp", "hr", "temp_f", "spo2"]);

const MEDICATION_KEYS = new Set(["name", "dose", "frequency", "route"]);

const DIAGNOSIS_KEYS = new Set(["description", "icd10"]);

const FOLLOW_UP_KEYS = new Set(["interval_days", "reason"]);

const validationFailed = (details: string): never => {
  throw new ApiError(422, "Validation failed", details);
};

const assertNonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    validationFailed(`${path} must be a non-empty string`);
  }
  return value as string;
};

const rejectExtraKeys = (obj: Record<string, unknown>, allowed: Set<string>, path: string): void => {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      validationFailed(`${path}: unknown or disallowed property "${key}"`);
    }
  }
};

const validateNullableString = (value: unknown, path: string): void => {
  if (value === null || typeof value === "string") {
    return;
  }
  validationFailed(`${path} must be a string or null`);
};

const validateNumberOrNull = (value: unknown, path: string): void => {
  if (value === null || (typeof value === "number" && Number.isFinite(value))) {
    return;
  }
  validationFailed(`${path} must be a finite number or null`);
};

const validateVitals = (value: unknown, basePath: string): void => {
  if (!isRecord(value)) {
    validationFailed(`${basePath} must be an object`);
  }
  const vitals = value as Record<string, unknown>;
  rejectExtraKeys(vitals, VITAL_SUBKEYS, basePath);
  for (const key of VITAL_SUBKEYS) {
    if (key in vitals) {
      validateNullableString(vitals[key], `${basePath}.${key}`);
    }
  }
};

const validateMedicationItem = (value: unknown, path: string): void => {
  if (!isRecord(value)) {
    validationFailed(`${path} must be an object`);
  }
  const med = value as Record<string, unknown>;
  rejectExtraKeys(med, MEDICATION_KEYS, path);
  for (const key of MEDICATION_KEYS) {
    if (!(key in med)) {
      validationFailed(`${path}: missing required property "${key}"`);
    }
    if (typeof med[key] !== "string") {
      validationFailed(`${path}.${key} must be a string`);
    }
  }
};

const validateDiagnosisItem = (value: unknown, path: string): void => {
  if (!isRecord(value)) {
    validationFailed(`${path} must be an object`);
  }
  const dx = value as Record<string, unknown>;
  rejectExtraKeys(dx, DIAGNOSIS_KEYS, path);
  if (!("description" in dx)) {
    validationFailed(`${path}: missing required property "description"`);
  }
  if (typeof dx.description !== "string") {
    validationFailed(`${path}.description must be a string`);
  }
  if ("icd10" in dx && typeof dx.icd10 !== "string") {
    validationFailed(`${path}.icd10 must be a string`);
  }
};

const validateFollowUp = (value: unknown, basePath: string): void => {
  if (!isRecord(value)) {
    validationFailed(`${basePath} must be an object`);
  }
  const fu = value as Record<string, unknown>;
  rejectExtraKeys(fu, FOLLOW_UP_KEYS, basePath);
  if (!("interval_days" in fu)) {
    validationFailed(`${basePath}: missing required property "interval_days"`);
  }
  if (!("reason" in fu)) {
    validationFailed(`${basePath}: missing required property "reason"`);
  }
  validateNumberOrNull(fu.interval_days, `${basePath}.interval_days`);
  if (fu.reason !== null && typeof fu.reason !== "string") {
    validationFailed(`${basePath}.reason must be a string or null`);
  }
};

const validateGroundTruth = (value: unknown, basePath: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    validationFailed(`${basePath} must be an object`);
  }

  const gt = value as Record<string, unknown>;
  rejectExtraKeys(gt, GROUND_TRUTH_KEYS, basePath);

  if (Object.keys(gt).length === 0) {
    validationFailed(`${basePath} must include at least one supported field`);
  }

  if ("chief_complaint" in gt) {
    if (typeof gt.chief_complaint !== "string") {
      validationFailed(`${basePath}.chief_complaint must be a string`);
    }
  }

  if ("vitals" in gt) {
    validateVitals(gt.vitals, `${basePath}.vitals`);
  }

  if ("medications" in gt) {
    if (!Array.isArray(gt.medications)) {
      validationFailed(`${basePath}.medications must be an array`);
    }
    (gt.medications as unknown[]).forEach((item: unknown, index: number) => {
      validateMedicationItem(item, `${basePath}.medications[${index}]`);
    });
  }

  if ("diagnoses" in gt) {
    if (!Array.isArray(gt.diagnoses)) {
      validationFailed(`${basePath}.diagnoses must be an array`);
    }
    (gt.diagnoses as unknown[]).forEach((item: unknown, index: number) => {
      validateDiagnosisItem(item, `${basePath}.diagnoses[${index}]`);
    });
  }

  if ("plan" in gt) {
    if (!Array.isArray(gt.plan)) {
      validationFailed(`${basePath}.plan must be an array`);
    }
    (gt.plan as unknown[]).forEach((item: unknown, index: number) => {
      if (typeof item !== "string") {
        validationFailed(`${basePath}.plan[${index}] must be a string`);
      }
    });
  }

  if ("follow_up" in gt) {
    validateFollowUp(gt.follow_up, `${basePath}.follow_up`);
  }

  return gt;
};

/**
 * Validates one test case (inline or from dataset) and returns a typed TestCase.
 * @param pathPrefix e.g. testCases[0] or dataset[2]
 */
export const validateTestCaseRecord = (raw: unknown, pathPrefix: string): TestCase => {
  if (!isRecord(raw)) {
    validationFailed(`${pathPrefix} must be an object`);
  }

  const tc = raw as Record<string, unknown>;
  rejectExtraKeys(tc, TEST_CASE_KEYS, pathPrefix);

  if (!("id" in tc)) {
    validationFailed(`${pathPrefix}: missing required property "id"`);
  }
  if (!("input" in tc)) {
    validationFailed(`${pathPrefix}: missing required property "input"`);
  }
  if (!("groundTruth" in tc)) {
    validationFailed(`${pathPrefix}: missing required property "groundTruth"`);
  }

  const id = assertNonEmptyString(tc.id, `${pathPrefix}.id`);
  const input = assertNonEmptyString(tc.input, `${pathPrefix}.input`);
  const groundTruth = validateGroundTruth(tc.groundTruth, `${pathPrefix}.groundTruth`);

  return { id, input, groundTruth };
};

export const validateTestCaseArray = (raw: unknown, label: string): TestCase[] => {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "Invalid input", `${label} must be an array`);
  }

  if (raw.length === 0) {
    throw new ApiError(400, "Invalid input", `${label} cannot be empty`);
  }

  return raw.map((item, index) => validateTestCaseRecord(item, `${label}[${index}]`));
};
