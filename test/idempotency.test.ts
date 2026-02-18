import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoordinatorState } from "../src/coordinator/state.js";

describe("idempotency persistence", () => {
  it("persists idempotency records across restarts", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skyclaw-idempotency-"));
    const dbPath = path.join(tmpDir, "coordinator.db");

    const stateA = new CoordinatorState({ dbPath });
    stateA.saveIdempotency("/v1/jobs", "req-123", "hash-abc", 200, { job: { id: "j1" } }, 60_000);

    const stateB = new CoordinatorState({ dbPath });
    const found = stateB.getIdempotency("/v1/jobs", "req-123");
    expect(found).toBeDefined();
    expect(found?.requestHash).toBe("hash-abc");
    expect(JSON.parse(found?.responseJson || "{}")).toEqual({ job: { id: "j1" } });
  });

  it("purges expired idempotency records", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skyclaw-idempotency-"));
    const dbPath = path.join(tmpDir, "coordinator.db");

    const state = new CoordinatorState({ dbPath });
    state.saveIdempotency("/v1/jobs", "req-expired", "hash-expired", 200, { ok: true }, -1_000);
    const removed = state.purgeExpiredIdempotency();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(state.getIdempotency("/v1/jobs", "req-expired")).toBeUndefined();
  });
});
