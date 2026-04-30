import { describe, expect, test } from "bun:test";
import { evaluateCase } from "../src/services/evaluate.service";

describe("evaluateCase scoring", () => {
  test("score is 1 only when prediction matches gold with no extra paths", () => {
    const gold = { a: 1, b: { c: 2 } };
    const pred = { a: 1, b: { c: 2 } };
    const r = evaluateCase(pred, gold);
    expect(r.missingFields.length).toBe(0);
    expect(r.extraFields.length).toBe(0);
    expect(r.mismatchedFields.length).toBe(0);
    expect(r.score).toBe(1);
  });

  test("extra fields reduce score", () => {
    const gold = { chief_complaint: "cough" };
    const pred = {
      chief_complaint: "cough",
      follow_up: { interval_days: 7, reason: "x" }
    };
    const r = evaluateCase(pred, gold);
    expect(r.extraFields.length).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
    const union = 1 + r.extraFields.length;
    const errors = r.missingFields.length + r.mismatchedFields.length + r.extraFields.length;
    expect(r.score).toBe(Number.parseFloat((1 - errors / union).toFixed(4)));
  });

  test("missing and mismatched count toward errors", () => {
    const gold = { a: 1, b: 2 };
    const pred = { a: 9 };
    const r = evaluateCase(pred, gold);
    expect(r.missingFields).toContain("b");
    expect(r.mismatchedFields.some((m) => m.path === "a")).toBeTrue();
    const union = 2 + r.extraFields.length;
    const errors = r.missingFields.length + r.mismatchedFields.length + r.extraFields.length;
    expect(r.score).toBe(Number.parseFloat(Math.max(0, 1 - errors / union).toFixed(4)));
  });
});
