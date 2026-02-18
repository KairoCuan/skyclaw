import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoordinatorState } from "../src/coordinator/state.js";

describe("CoordinatorState", () => {
  it("assigns jobs to matching hosts", () => {
    const state = new CoordinatorState({ leaseMs: 10_000 });
    const host = state.registerHost({
      name: "openclaw-a",
      capabilities: ["shell", "openclaw"],
      maxParallel: 1
    });

    state.enqueueJob({
      payload: { kind: "openclaw-run", args: ["run"] },
      requirement: { requiredCapabilities: ["openclaw"] }
    });

    const claim = state.claimJob(host.id);
    expect(claim.job?.status).toBe("leased");
    expect(claim.job?.assignedHostId).toBe(host.id);
  });

  it("requeues expired leases", async () => {
    const state = new CoordinatorState({ leaseMs: 10 });
    const host = state.registerHost({
      name: "openclaw-b",
      capabilities: ["shell"],
      maxParallel: 1
    });

    state.enqueueJob({
      payload: { kind: "shell", command: "bash", args: ["-lc", "echo hi"] }
    });

    const first = state.claimJob(host.id);
    expect(first.job).not.toBeNull();

    await new Promise((r) => setTimeout(r, 20));

    const requeued = state.requeueExpiredLeases();
    expect(requeued).toBe(1);

    const second = state.claimJob(host.id);
    expect(second.job?.id).toBe(first.job?.id);
    expect(second.job?.attempts).toBe(2);
  });

  it("records completion output", () => {
    const state = new CoordinatorState({ leaseMs: 1_000 });
    const host = state.registerHost({ name: "openclaw-c", capabilities: ["shell"] });
    const job = state.enqueueJob({
      payload: { kind: "shell", command: "bash", args: ["-lc", "echo ok"] }
    });
    state.claimJob(host.id);

    const completed = state.completeJob(job.id, {
      hostId: host.id,
      success: true,
      durationMs: 42,
      exitCode: 0,
      stdout: "ok\n",
      stderr: ""
    });

    expect(completed.status).toBe("completed");
    expect(completed.result?.stdout).toBe("ok\n");
  });

  it("stores submitter identity and allows job lookup", () => {
    const state = new CoordinatorState();
    const job = state.enqueueJob({
      payload: { kind: "openclaw-run", args: ["run"] },
      requirement: { requiredCapabilities: ["openclaw"] },
      submittedBy: "public:website"
    });

    const loaded = state.getJob(job.id);
    expect(loaded?.submittedBy).toBe("public:website");
  });

  it("deploys, claims, and reports service status", () => {
    const state = new CoordinatorState();
    const host = state.registerHost({
      name: "service-host-1",
      capabilities: ["service-host"],
      maxParallel: 1
    });

    const service = state.deployService({
      name: "ts-api",
      command: "node",
      args: ["server.js"],
      replicas: 1,
      requiredCapabilities: ["service-host"]
    });
    expect(service.status).toBe("pending");

    const claim = state.claimService(host.id);
    expect(claim.service?.id).toBe(service.id);

    const running = state.reportService(service.id, {
      hostId: host.id,
      status: "running",
      endpoint: "https://node-a.example.com:3100"
    });
    expect(running.status).toBe("running");
    expect(running.assignments[0]?.endpoint).toContain("3100");
  });

  it("reloads state from sqlite after restart", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skyclaw-state-"));
    const dbPath = path.join(tmpDir, "coordinator.db");

    const stateA = new CoordinatorState({ leaseMs: 10, dbPath });
    const host = stateA.registerHost({ name: "openclaw-d", capabilities: ["shell"] });
    const job = stateA.enqueueJob({
      payload: { kind: "shell", command: "bash", args: ["-lc", "echo persist"] }
    });
    const claim = stateA.claimJob(host.id);
    expect(claim.job?.id).toBe(job.id);

    const stateB = new CoordinatorState({ leaseMs: 10, dbPath });
    const snapshot = stateB.snapshot();
    expect(snapshot.hosts).toHaveLength(1);
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]?.id).toBe(job.id);

    await new Promise((r) => setTimeout(r, 20));
    const requeued = stateB.requeueExpiredLeases();
    expect(requeued).toBe(1);
    const claimAgain = stateB.claimJob(host.id);
    expect(claimAgain.job?.id).toBe(job.id);
    expect(claimAgain.job?.attempts).toBe(2);
  });

  it("merges newer peer snapshots", () => {
    const nodeA = new CoordinatorState({ nodeId: "node-a" });
    const host = nodeA.registerHost({ name: "openclaw-peer", capabilities: ["shell"] });
    const job = nodeA.enqueueJob({
      payload: { kind: "shell", command: "bash", args: ["-lc", "echo multi"] }
    });

    const nodeB = new CoordinatorState({ nodeId: "node-b" });
    const merged = nodeB.mergeSnapshot(nodeA.snapshot());
    expect(merged.changed).toBe(true);

    const snapB = nodeB.snapshot();
    expect(snapB.hosts.some((h) => h.id === host.id)).toBe(true);
    expect(snapB.jobs.some((j) => j.id === job.id)).toBe(true);

    const secondMerge = nodeB.mergeSnapshot(nodeA.snapshot());
    expect(secondMerge.changed).toBe(false);
  });

  it("restores checkpoint to rollback local mutations", () => {
    const state = new CoordinatorState({ nodeId: "node-rollback" });
    const before = state.checkpoint();

    state.registerHost({ name: "temporary-host", capabilities: ["shell"] });
    state.enqueueJob({ payload: { kind: "shell", command: "bash", args: ["-lc", "echo temp"] } });
    const changed = state.snapshot();
    expect(changed.hosts.length).toBeGreaterThan(0);
    expect(changed.jobs.length).toBeGreaterThan(0);

    state.restore(before);
    const after = state.snapshot();
    expect(after.hosts).toHaveLength(0);
    expect(after.jobs).toHaveLength(0);
  });
});
