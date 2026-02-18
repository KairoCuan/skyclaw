export type JobStatus = "queued" | "leased" | "completed" | "failed";
export type ServiceStatus = "pending" | "running" | "failed";

export interface JobRequirement {
  requiredCapabilities?: string[];
}

export interface ShellJobPayload {
  kind: "shell";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface OpenClawRunJobPayload {
  kind: "openclaw-run";
  args?: string[];
  openclawDir?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type JobPayload = ShellJobPayload | OpenClawRunJobPayload;

export interface JobRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  status: JobStatus;
  attempts: number;
  leaseExpiresAt?: string;
  assignedHostId?: string;
  requirement: JobRequirement;
  payload: JobPayload;
  submittedBy?: string;
  result?: {
    finishedAt: string;
    durationMs: number;
    exitCode: number;
    stdout: string;
    stderr: string;
  };
  error?: string;
}

export interface HostRecord {
  id: string;
  name: string;
  capabilities: string[];
  maxParallel: number;
  activeLeases: number;
  lastSeenAt: string;
  registeredAt: string;
  updatedBy: string;
  version: number;
}

export interface RegisterHostRequest {
  hostId?: string;
  name: string;
  capabilities?: string[];
  maxParallel?: number;
}

export interface RegisterHostResponse {
  host: HostRecord;
}

export interface HeartbeatRequest {
  activeLeases?: number;
}

export interface EnqueueJobRequest {
  payload: JobPayload;
  requirement?: JobRequirement;
  submittedBy?: string;
}

export interface PublicSubmitJobRequest {
  payload: JobPayload;
  requirement?: JobRequirement;
}

export interface ServiceDeployRequest {
  serviceId?: string;
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  replicas?: number;
  requiredCapabilities?: string[];
}

export interface ServiceRecord {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  replicas: number;
  requiredCapabilities: string[];
  status: ServiceStatus;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  assignments: Array<{
    hostId: string;
    status: ServiceStatus;
    endpoint?: string;
    error?: string;
    startedAt?: string;
    updatedAt: string;
  }>;
}

export interface ServiceClaimResponse {
  service: ServiceRecord | null;
}

export interface ServiceReportRequest {
  hostId: string;
  status: ServiceStatus;
  endpoint?: string;
  error?: string;
}

export interface ClaimJobResponse {
  job: JobRecord | null;
}

export interface CompleteJobRequest {
  hostId: string;
  success: boolean;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CoordinatorSnapshot {
  nodeId?: string;
  hosts: HostRecord[];
  jobs: JobRecord[];
  services?: ServiceRecord[];
}
