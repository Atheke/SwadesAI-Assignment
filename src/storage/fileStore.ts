import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PersistedState } from "../models/types";

const defaultState = (): PersistedState => ({
  runs: {},
  idempotency: {}
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
        const parsed = JSON.parse(content) as PersistedState;
        return {
          runs: parsed.runs ?? {},
          idempotency: parsed.idempotency ?? {}
        };
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
        current = JSON.parse(text) as PersistedState;
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
