import type { HostRecord, JobRecord, RegisterHostResponse } from "../types.js";
import { parseIntEnv } from "../util.js";
import { runJob, type HostExecutionConfig } from "./runner.js";

export interface HostDaemonConfig {
  coordinatorUrls: string[];
  token?: string;
  hostName: string;
  hostId?: string;
  capabilities: string[];
  maxParallel: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  execution: HostExecutionConfig;
}

class CoordinatorClient {
  private activeIndex = 0;

  constructor(
    private readonly urls: string[],
    private readonly token?: string
  ) {}

  async postJson<T>(path: string, body: unknown): Promise<T> {
    let lastError: unknown;

    for (let i = 0; i < this.urls.length; i += 1) {
      const index = (this.activeIndex + i) % this.urls.length;
      const baseUrl = this.urls[index];
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.token ? { "x-skyclaw-token": this.token } : {})
          },
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          throw new Error(`request failed (${response.status}): ${await response.text()}`);
        }

        this.activeIndex = index;
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("all coordinators unavailable");
  }
}

export async function startHostDaemon(config: HostDaemonConfig): Promise<void> {
  if (config.coordinatorUrls.length === 0) {
    throw new Error("at least one coordinator URL is required");
  }
  const client = new CoordinatorClient(config.coordinatorUrls, config.token);

  const registerRes = await client.postJson<RegisterHostResponse>("/v1/hosts/register", {
    hostId: config.hostId,
    name: config.hostName,
    capabilities: config.capabilities,
    maxParallel: config.maxParallel
  });

  let host: HostRecord = registerRes.host;
  process.stdout.write(`[skyclaw] host registered: ${host.id} (${host.name})\n`);

  setInterval(async () => {
    try {
      const next = await client.postJson<{ host: HostRecord }>(
        `/v1/hosts/${encodeURIComponent(host.id)}/heartbeat`,
        { activeLeases: host.activeLeases }
      );
      host = next.host;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[skyclaw] heartbeat failed: ${msg}\n`);
    }
  }, config.heartbeatIntervalMs).unref();

  for (;;) {
    try {
      const claim = await client.postJson<{ job: JobRecord | null }>(
        `/v1/hosts/${encodeURIComponent(host.id)}/claim`,
        {}
      );

      if (!claim.job) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      host.activeLeases += 1;
      process.stdout.write(`[skyclaw] running ${claim.job.id} (${claim.job.payload.kind})\n`);
      const result = await runJob(claim.job.payload, config.execution);

      await client.postJson(`/v1/jobs/${encodeURIComponent(claim.job.id)}/complete`, {
        hostId: host.id,
        success: result.success,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error
      });

      if (host.activeLeases > 0) {
        host.activeLeases -= 1;
      }
      const status = result.success ? "ok" : "failed";
      process.stdout.write(`[skyclaw] completed ${claim.job.id}: ${status}\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[skyclaw] worker loop error: ${msg}\n`);
      await sleep(config.pollIntervalMs);
    }
  }
}

export function hostConfigFromEnv(): HostDaemonConfig {
  const coordinatorUrls = parseCoordinatorUrlsFromEnv();
  const token = process.env.SKYCLAW_TOKEN;
  const hostName = process.env.SKYCLAW_HOST_NAME || `openclaw-node-${process.pid}`;
  const hostId = process.env.SKYCLAW_HOST_ID;
  const capabilities = (process.env.SKYCLAW_CAPABILITIES || "shell,openclaw")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const allowedCommands = (process.env.SKYCLAW_ALLOWED_COMMANDS || "openclaw,node,bash,sh")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  return {
    coordinatorUrls,
    token,
    hostName,
    hostId,
    capabilities,
    maxParallel: parseIntEnv("SKYCLAW_MAX_PARALLEL", 1),
    pollIntervalMs: parseIntEnv("SKYCLAW_POLL_MS", 2_000),
    heartbeatIntervalMs: parseIntEnv("SKYCLAW_HEARTBEAT_MS", 5_000),
    execution: {
      allowedCommands,
      defaultTimeoutMs: parseIntEnv("SKYCLAW_TIMEOUT_MS", 300_000),
      maxOutputBytes: parseIntEnv("SKYCLAW_MAX_OUTPUT_BYTES", 128_000),
      openclawCommand: process.env.SKYCLAW_OPENCLAW_COMMAND || "openclaw"
    }
  };
}

export function parseCoordinatorUrlsFromEnv(): string[] {
  const list = process.env.SKYCLAW_COORDINATOR_URLS;
  if (list?.trim()) {
    return list
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [process.env.SKYCLAW_COORDINATOR_URL || "http://127.0.0.1:8787"];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
