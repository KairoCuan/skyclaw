import type {
  ClaimJobResponse,
  CompleteJobRequest,
  CoordinatorSnapshot,
  EnqueueJobRequest,
  HostRecord,
  JobRecord,
  RegisterHostRequest,
  ServiceClaimResponse,
  ServiceDeployRequest,
  ServiceRecord,
  ServiceReportRequest
} from "../types.js";
import { hasCapabilities, makeId, normalizeCapabilities, nowIso } from "../util.js";
import { CoordinatorStorage } from "./storage.js";
import type { StoredIdempotencyRecord } from "./storage.js";

export interface CoordinatorStateOptions {
  leaseMs?: number;
  dbPath?: string;
  nodeId?: string;
}

export class CoordinatorState {
  private readonly hosts = new Map<string, HostRecord>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly services = new Map<string, ServiceRecord>();
  private readonly leaseMs: number;
  private readonly storage?: CoordinatorStorage;
  private readonly nodeId: string;
  private nextVersion = 1;

  constructor(options: CoordinatorStateOptions = {}) {
    this.leaseMs = options.leaseMs ?? 60_000;
    this.nodeId = options.nodeId?.trim() || makeId("node");
    if (options.dbPath) {
      this.storage = new CoordinatorStorage(options.dbPath);
      for (const host of this.storage.loadHosts()) {
        this.hosts.set(host.id, host);
      }
      for (const job of this.storage.loadJobs()) {
        this.jobs.set(job.id, job);
      }
      for (const service of this.storage.loadServices()) {
        this.services.set(service.id, service);
      }
      const maxHostVersion = Math.max(0, ...[...this.hosts.values()].map((host) => host.version || 0));
      const maxJobVersion = Math.max(0, ...[...this.jobs.values()].map((job) => job.version || 0));
      const maxServiceVersion = Math.max(
        0,
        ...[...this.services.values()].map((service) => service.version || 0)
      );
      this.nextVersion = Math.max(maxHostVersion, maxJobVersion, maxServiceVersion) + 1;
    }
  }

  getNodeId(): string {
    return this.nodeId;
  }

  registerHost(input: RegisterHostRequest): HostRecord {
    const id = input.hostId?.trim() || makeId("host");
    const existing = this.hosts.get(id);
    const now = nowIso();
    const host: HostRecord = {
      id,
      name: input.name.trim(),
      capabilities: normalizeCapabilities(input.capabilities),
      maxParallel: Math.max(1, input.maxParallel ?? 1),
      activeLeases: existing?.activeLeases ?? 0,
      lastSeenAt: now,
      registeredAt: existing?.registeredAt ?? now,
      updatedBy: this.nodeId,
      version: this.bumpVersion()
    };
    this.hosts.set(id, host);
    this.storage?.saveHost(host);
    return structuredClone(host);
  }

  heartbeat(hostId: string, activeLeases?: number): HostRecord {
    const host = this.hosts.get(hostId);
    if (!host) {
      throw new Error(`unknown host: ${hostId}`);
    }
    host.lastSeenAt = nowIso();
    if (typeof activeLeases === "number" && Number.isFinite(activeLeases) && activeLeases >= 0) {
      host.activeLeases = activeLeases;
    }
    this.touchHost(host);
    return structuredClone(host);
  }

  enqueueJob(input: EnqueueJobRequest): JobRecord {
    const now = nowIso();
    const record: JobRecord = {
      id: makeId("job"),
      createdAt: now,
      updatedAt: now,
      updatedBy: this.nodeId,
      version: this.bumpVersion(),
      status: "queued",
      attempts: 0,
      requirement: {
        requiredCapabilities: normalizeCapabilities(input.requirement?.requiredCapabilities)
      },
      payload: input.payload,
      submittedBy: input.submittedBy?.trim() || undefined
    };
    this.jobs.set(record.id, record);
    this.storage?.saveJob(record);
    return structuredClone(record);
  }

  claimJob(hostId: string): ClaimJobResponse {
    this.requeueExpiredLeases();
    const host = this.hosts.get(hostId);
    if (!host) {
      throw new Error(`unknown host: ${hostId}`);
    }
    if (host.activeLeases >= host.maxParallel) {
      return { job: null };
    }

    const queued = [...this.jobs.values()]
      .filter((job) => job.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const next = queued.find((job) =>
      hasCapabilities(host.capabilities, job.requirement.requiredCapabilities)
    );

    if (!next) {
      return { job: null };
    }

    next.status = "leased";
    next.attempts += 1;
    next.assignedHostId = hostId;
    next.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
    this.touchJob(next);

    host.activeLeases += 1;
    this.touchHost(host);

    return { job: structuredClone(next) };
  }

  completeJob(jobId: string, input: CompleteJobRequest): JobRecord {
    const host = this.hosts.get(input.hostId);
    if (!host) {
      throw new Error(`unknown host: ${input.hostId}`);
    }
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`unknown job: ${jobId}`);
    }
    if (job.assignedHostId !== input.hostId) {
      throw new Error(`job ${jobId} is assigned to ${job.assignedHostId ?? "nobody"}`);
    }
    if (job.status !== "leased") {
      throw new Error(`job ${jobId} is not leased`);
    }

    job.status = input.success ? "completed" : "failed";
    job.result = {
      finishedAt: nowIso(),
      durationMs: input.durationMs,
      exitCode: input.exitCode,
      stdout: input.stdout,
      stderr: input.stderr
    };
    job.error = input.error;
    job.leaseExpiresAt = undefined;
    this.touchJob(job);

    if (host.activeLeases > 0) {
      host.activeLeases -= 1;
    }
    this.touchHost(host);

    return structuredClone(job);
  }

  deployService(input: ServiceDeployRequest): ServiceRecord {
    const now = nowIso();
    const id = input.serviceId?.trim() || makeId("svc");
    const record: ServiceRecord = {
      id,
      name: input.name.trim(),
      command: input.command.trim(),
      args: input.args ?? [],
      cwd: input.cwd,
      env: input.env,
      replicas: Math.max(1, input.replicas ?? 1),
      requiredCapabilities: normalizeCapabilities(input.requiredCapabilities ?? ["service-host"]),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      updatedBy: this.nodeId,
      version: this.bumpVersion(),
      assignments: []
    };
    this.services.set(record.id, record);
    this.storage?.saveService(record);
    return structuredClone(record);
  }

  listServices(): ServiceRecord[] {
    return [...this.services.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((service) => structuredClone(service));
  }

  getService(serviceId: string): ServiceRecord | undefined {
    const service = this.services.get(serviceId);
    return service ? structuredClone(service) : undefined;
  }

  claimService(hostId: string): ServiceClaimResponse {
    const host = this.hosts.get(hostId);
    if (!host) {
      throw new Error(`unknown host: ${hostId}`);
    }

    const candidates = [...this.services.values()]
      .filter((service) => hasCapabilities(host.capabilities, service.requiredCapabilities))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const service of candidates) {
      const existing = service.assignments.find((assignment) => assignment.hostId === hostId);
      if (existing) {
        if (existing.status === "failed") {
          continue;
        }
        return { service: structuredClone(service) };
      }
      if (service.assignments.length >= service.replicas) {
        continue;
      }

      service.assignments.push({
        hostId,
        status: "pending",
        updatedAt: nowIso()
      });
      this.touchService(service);
      return { service: structuredClone(service) };
    }

    return { service: null };
  }

  reportService(serviceId: string, input: ServiceReportRequest): ServiceRecord {
    const service = this.services.get(serviceId);
    if (!service) {
      throw new Error(`unknown service: ${serviceId}`);
    }
    const assignment = service.assignments.find((item) => item.hostId === input.hostId);
    if (!assignment) {
      throw new Error(`service ${serviceId} is not assigned to host ${input.hostId}`);
    }
    assignment.status = input.status;
    assignment.endpoint = input.endpoint;
    assignment.error = input.error;
    assignment.updatedAt = nowIso();
    if (input.status === "running" && !assignment.startedAt) {
      assignment.startedAt = nowIso();
    }
    if (service.assignments.some((item) => item.status === "running")) {
      service.status = "running";
    } else if (service.assignments.some((item) => item.status === "pending")) {
      service.status = "pending";
    } else {
      service.status = "failed";
    }
    this.touchService(service);
    return structuredClone(service);
  }

  requeueExpiredLeases(): number {
    const now = Date.now();
    let requeued = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== "leased" || !job.leaseExpiresAt) {
        continue;
      }
      if (new Date(job.leaseExpiresAt).getTime() > now) {
        continue;
      }
      const host = job.assignedHostId ? this.hosts.get(job.assignedHostId) : undefined;
      if (host && host.activeLeases > 0) {
        host.activeLeases -= 1;
        this.touchHost(host);
      }
      job.status = "queued";
      job.assignedHostId = undefined;
      job.leaseExpiresAt = undefined;
      this.touchJob(job);
      requeued += 1;
    }
    return requeued;
  }

  mergeSnapshot(snapshot: CoordinatorSnapshot): { changed: boolean } {
    let changed = false;

    for (const incomingHost of snapshot.hosts || []) {
      const current = this.hosts.get(incomingHost.id);
      if (!current || shouldAdopt(current, incomingHost)) {
        const adopted = structuredClone(incomingHost);
        this.hosts.set(adopted.id, adopted);
        this.storage?.saveHost(adopted);
        this.nextVersion = Math.max(this.nextVersion, (adopted.version || 0) + 1);
        changed = true;
      }
    }

    for (const incomingJob of snapshot.jobs || []) {
      const current = this.jobs.get(incomingJob.id);
      if (!current || shouldAdopt(current, incomingJob)) {
        const adopted = structuredClone(incomingJob);
        this.jobs.set(adopted.id, adopted);
        this.storage?.saveJob(adopted);
        this.nextVersion = Math.max(this.nextVersion, (adopted.version || 0) + 1);
        changed = true;
      }
    }

    for (const incomingService of snapshot.services || []) {
      const current = this.services.get(incomingService.id);
      if (!current || shouldAdopt(current, incomingService)) {
        const adopted = structuredClone(incomingService);
        this.services.set(adopted.id, adopted);
        this.storage?.saveService(adopted);
        this.nextVersion = Math.max(this.nextVersion, (adopted.version || 0) + 1);
        changed = true;
      }
    }

    return { changed };
  }

  snapshot(): CoordinatorSnapshot {
    this.requeueExpiredLeases();
    return this.snapshotInternal();
  }

  checkpoint(): CoordinatorSnapshot {
    return this.snapshotInternal();
  }

  restore(snapshot: CoordinatorSnapshot): void {
    this.hosts.clear();
    this.jobs.clear();
    this.services.clear();

    for (const host of snapshot.hosts || []) {
      this.hosts.set(host.id, structuredClone(host));
    }
    for (const job of snapshot.jobs || []) {
      this.jobs.set(job.id, structuredClone(job));
    }
    for (const service of snapshot.services || []) {
      this.services.set(service.id, structuredClone(service));
    }

    const maxHostVersion = Math.max(0, ...[...this.hosts.values()].map((host) => host.version || 0));
    const maxJobVersion = Math.max(0, ...[...this.jobs.values()].map((job) => job.version || 0));
    const maxServiceVersion = Math.max(
      0,
      ...[...this.services.values()].map((service) => service.version || 0)
    );
    this.nextVersion = Math.max(maxHostVersion, maxJobVersion, maxServiceVersion) + 1;

    if (this.storage) {
      this.storage.replaceAll(
        [...this.hosts.values()].map((host) => structuredClone(host)),
        [...this.jobs.values()].map((job) => structuredClone(job)),
        [...this.services.values()].map((service) => structuredClone(service))
      );
    }
  }

  getJob(jobId: string): JobRecord | undefined {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  getIdempotency(route: string, key: string): StoredIdempotencyRecord | undefined {
    return this.storage?.getIdempotency(route, key);
  }

  saveIdempotency(
    route: string,
    key: string,
    requestHash: string,
    statusCode: number,
    responseBody: unknown,
    ttlMs: number
  ): void {
    if (!this.storage) return;
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.storage.saveIdempotency({
      route,
      key,
      requestHash,
      statusCode,
      responseJson: JSON.stringify(responseBody),
      createdAt,
      expiresAt
    });
  }

  purgeExpiredIdempotency(now: string = nowIso()): number {
    if (!this.storage) return 0;
    return this.storage.deleteExpiredIdempotency(now);
  }

  private snapshotInternal(): CoordinatorSnapshot {
    return {
      nodeId: this.nodeId,
      hosts: [...this.hosts.values()].map((host) => structuredClone(host)),
      jobs: [...this.jobs.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((job) => structuredClone(job)),
      services: [...this.services.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((service) => structuredClone(service))
    };
  }

  private bumpVersion(): number {
    const version = this.nextVersion;
    this.nextVersion += 1;
    return version;
  }

  private touchHost(host: HostRecord): void {
    host.version = this.bumpVersion();
    host.updatedBy = this.nodeId;
    this.storage?.saveHost(host);
  }

  private touchJob(job: JobRecord): void {
    job.updatedAt = nowIso();
    job.version = this.bumpVersion();
    job.updatedBy = this.nodeId;
    this.storage?.saveJob(job);
  }

  private touchService(service: ServiceRecord): void {
    service.updatedAt = nowIso();
    service.version = this.bumpVersion();
    service.updatedBy = this.nodeId;
    this.storage?.saveService(service);
  }
}

function shouldAdopt<T extends { version?: number; updatedBy?: string; updatedAt?: string }>(
  local: T,
  incoming: T
): boolean {
  const localVersion = local.version || 0;
  const incomingVersion = incoming.version || 0;
  if (incomingVersion !== localVersion) {
    return incomingVersion > localVersion;
  }

  const localUpdatedAt = local.updatedAt || "";
  const incomingUpdatedAt = incoming.updatedAt || "";
  if (incomingUpdatedAt !== localUpdatedAt) {
    return incomingUpdatedAt > localUpdatedAt;
  }

  const localUpdatedBy = local.updatedBy || "";
  const incomingUpdatedBy = incoming.updatedBy || "";
  return incomingUpdatedBy > localUpdatedBy;
}
