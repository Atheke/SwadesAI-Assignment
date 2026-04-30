import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { IdempotencyEntry, PersistedState } from "../models/types";

const defaultState = (): PersistedState => ({
  runs: {},
  idempotency: {}
});

const normalizeIdempotency = (raw: Record<string, unknown>): Record<string, IdempotencyEntry> => {
  const out: Record<string, IdempotencyEntry> = {};

  for (const [key, val] of Object.entries(raw ?? {})) {
    if (typeof val === "string") {
      out[key] = { runId: val, payloadHash: "" };
      continue;
    }

    if (val && typeof val === "object" && "runId" in val) {
      const entry = val as Record<string, unknown>;
      const runId = typeof entry.runId === "string" ? entry.runId : "";
      const payloadHash = typeof entry.payloadHash === "string" ? entry.payloadHash : "";

      if (runId) {
        out[key] = { runId, payloadHash };
      }
    }
  }

  return out;
};

const normalizePersistedState = (parsed: Partial<PersistedState>): PersistedState => ({
  runs: parsed.runs ?? {},
  idempotency: normalizeIdempotency((parsed.idempotency ?? {}) as Record<string, unknown>)
});

export class FileStore {
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lock.then(operation, operation);
    this.lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async readState(): Promise<PersistedState> {
    return this.withLock(async () => {
      try {
        const content = await Bun.file(this.filePath).text();
        const parsed = JSON.parse(content) as Partial<PersistedState>;
        return normalizePersistedState(parsed);
      } catch {
        const fresh = defaultState();
        await mkdir(dirname(this.filePath), { recursive: true });
        await Bun.write(this.filePath, JSON.stringify(fresh, null, 2));
        return fresh;
      }
    });
  }

  async writeState(state: PersistedState): Promise<void> {
    return this.withLock(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await Bun.write(this.filePath, JSON.stringify(state, null, 2));
    });
  }

  async updateState(mutator: (state: PersistedState) => void): Promise<PersistedState> {
    return this.withLock(async () => {
      let current: PersistedState;

      try {
        const text = await Bun.file(this.filePath).text();
        current = normalizePersistedState(JSON.parse(text) as Partial<PersistedState>);
      } catch {
        current = defaultState();
      }

      current.runs = current.runs ?? {};
      current.idempotency = current.idempotency ?? {};

      mutator(current);

      await mkdir(dirname(this.filePath), { recursive: true });
      await Bun.write(this.filePath, JSON.stringify(current, null, 2));
      return current;
    });
  }
}
