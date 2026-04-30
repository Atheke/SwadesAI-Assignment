import type { CaseTokenUsage } from "../models/types";

const PRICE_PER_1K_INPUT = 0.0003;
const PRICE_PER_1K_OUTPUT = 0.0012;

const clean = (value: string): string => value.trim().replace(/\s+/g, " ");

const extractByRegex = (input: string, regex: RegExp): string | null => {
  const match = input.match(regex);
  return match?.[1] ? clean(match[1]) : null;
};

const parseMedications = (input: string): Array<Record<string, string>> => {
  const section = extractByRegex(input, /medications?:\s*([^\n]+)/i);
  if (!section) {
    return [];
  }

  return section
    .split(",")
    .map((chunk) => clean(chunk))
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(" ");
      return {
        name: parts[0] ?? "unknown",
        dose: parts[1] ?? "unknown",
        frequency: parts[2] ?? "unknown",
        route: parts[3] ?? "unknown"
      };
    });
};

const parsePlan = (input: string): string[] => {
  const section = extractByRegex(input, /plan:\s*([^\n]+)/i);
  if (!section) {
    return [];
  }

  return section
    .split(/[;,]/)
    .map((item) => clean(item))
    .filter(Boolean);
};

export const processCase = (input: string): Record<string, unknown> => {
  const followUpDaysText = extractByRegex(input, /follow\s*up\s*in\s*(\d+)\s*days/i);
  const followUpReason = extractByRegex(input, /follow\s*up\s*(?:in\s*\d+\s*days)?\s*for\s*([^\n]+)/i);

  return {
    chief_complaint:
      extractByRegex(input, /chief\s*complaint:\s*([^\n]+)/i) ??
      extractByRegex(input, /complaint:\s*([^\n]+)/i) ??
      "not specified",
    vitals: {
      bp: extractByRegex(input, /bp\s*[:=]\s*([0-9]{2,3}\/[0-9]{2,3})/i),
      hr: extractByRegex(input, /hr\s*[:=]\s*(\d{2,3})/i),
      temp_f: extractByRegex(input, /temp(?:_f)?\s*[:=]\s*([0-9]+(?:\.[0-9])?)/i),
      spo2: extractByRegex(input, /spo2\s*[:=]\s*(\d{2,3})/i)
    },
    medications: parseMedications(input),
    diagnoses: [
      {
        description: extractByRegex(input, /diagnosis:\s*([^\n]+)/i) ?? "unspecified diagnosis"
      }
    ],
    plan: parsePlan(input),
    follow_up: {
      interval_days: followUpDaysText ? Number.parseInt(followUpDaysText, 10) : null,
      reason: followUpReason
    }
  };
};

export const simulateTokenUsage = (input: string, prediction: Record<string, unknown>): CaseTokenUsage => {
  const inputTokens = Math.max(1, Math.ceil(input.length / 4));
  const outputTokens = Math.max(1, Math.ceil(JSON.stringify(prediction).length / 4));
  const totalTokens = inputTokens + outputTokens;
  const costUsd = Number.parseFloat(
    ((inputTokens / 1000) * PRICE_PER_1K_INPUT + (outputTokens / 1000) * PRICE_PER_1K_OUTPUT).toFixed(6)
  );

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd
  };
};
