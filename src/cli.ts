#!/usr/bin/env node
import { startCoordinatorServer, type PublicApiKey } from "./coordinator/server.js";
import { gatewayConfigFromEnv, startGatewayServer } from "./gateway/server.js";
import { hostConfigFromEnv, parseCoordinatorUrlsFromEnv, startHostDaemon } from "./host/daemon.js";
import { parseIntEnv } from "./util.js";

function printHelp(): void {
  process.stdout.write(`skyclaw - decentralized OpenClaw server network\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  skyclaw coordinator\n`);
  process.stdout.write(`  skyclaw host\n`);
  process.stdout.write(`  skyclaw gateway\n`);
  process.stdout.write(`  skyclaw enqueue-shell <command> [args...]\n`);
  process.stdout.write(`  skyclaw enqueue-openclaw [openclaw args...]\n`);
  process.stdout.write(`  skyclaw deploy-service <name> <command> [args...]\n`);
  process.stdout.write(`  skyclaw list-services\n`);
  process.stdout.write(`\nEnvironment:\n`);
  process.stdout.write(`  SKYCLAW_COORDINATOR_URL=http://127.0.0.1:8787\n`);
  process.stdout.write(`  SKYCLAW_COORDINATOR_URLS=http://127.0.0.1:8787,http://127.0.0.1:8788\n`);
  process.stdout.write(`  SKYCLAW_PEER_URLS=http://127.0.0.1:8788,http://127.0.0.1:8789\n`);
  process.stdout.write(`  SKYCLAW_COORDINATOR_NODE_ID=node-a\n`);
  process.stdout.write(`  SKYCLAW_COORDINATOR_PUBLIC_URL=http://<public-host>:8787\n`);
  process.stdout.write(`  SKYCLAW_MIN_REPLICATIONS=2\n`);
  process.stdout.write(`  SKYCLAW_PEER_DISCOVERY=1\n`);
  process.stdout.write(`  SKYCLAW_IDEMPOTENCY_TTL_MS=86400000\n`);
  process.stdout.write(`  SKYCLAW_TOKEN=<shared-token>\n`);
  process.stdout.write(`  SKYCLAW_PUBLIC_API_KEYS=website-key:website:openclaw\n`);
  process.stdout.write(`  SKYCLAW_PUBLIC_CORS_ORIGIN=https://your-site.com\n`);
  process.stdout.write(`  SKYCLAW_ALLOWED_COMMANDS=openclaw,node,bash,sh\n`);
  process.stdout.write(`  SKYCLAW_SERVICE_HOST_ENABLED=1\n`);
  process.stdout.write(`  SKYCLAW_SERVICE_BASE_PORT=3100\n`);
  process.stdout.write(`  SKYCLAW_SERVICE_HOST_PUBLIC_BASE_URL=http://<host>\n`);
  process.stdout.write(`  SKYCLAW_DB_PATH=.skyclaw/coordinator.db\n`);
  process.stdout.write(`  SKYCLAW_GATEWAY_PORT=8790\n`);
  process.stdout.write(`  SKYCLAW_GATEWAY_REFRESH_MS=3000\n`);
}

function parsePublicApiKeysFromEnv(): PublicApiKey[] {
  const raw = process.env.SKYCLAW_PUBLIC_API_KEYS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, label, capsRaw, shellRaw] = entry.split(":").map((part) => part.trim());
      const allowedCapabilities = (capsRaw || "openclaw")
        .split("|")
        .map((cap) => cap.trim())
        .filter(Boolean);
      return {
        key,
        label: label || undefined,
        allowedCapabilities,
        allowShell: shellRaw === "shell"
      };
    })
    .filter((rule) => Boolean(rule.key));
}

class CoordinatorClient {
  private activeIndex = 0;

  constructor(
    private readonly urls: string[],
    private readonly token?: string
  ) {}

  async postJson(path: string, body: unknown): Promise<any> {
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

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`request failed (${response.status}): ${text}`);
        }

        this.activeIndex = index;
        return text ? JSON.parse(text) : {};
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("all coordinators unavailable");
  }

  async getJson(path: string): Promise<any> {
    let lastError: unknown;
    for (let i = 0; i < this.urls.length; i += 1) {
      const index = (this.activeIndex + i) % this.urls.length;
      const baseUrl = this.urls[index];
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: {
            ...(this.token ? { "x-skyclaw-token": this.token } : {})
          }
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`request failed (${response.status}): ${text}`);
        }
        this.activeIndex = index;
        return text ? JSON.parse(text) : {};
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("all coordinators unavailable");
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "coordinator") {
    const peerUrls = (process.env.SKYCLAW_PEER_URLS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    await startCoordinatorServer({
      port: parseIntEnv("SKYCLAW_COORDINATOR_PORT", 8787),
      host: process.env.SKYCLAW_COORDINATOR_HOST || "0.0.0.0",
      authToken: process.env.SKYCLAW_TOKEN,
      leaseMs: parseIntEnv("SKYCLAW_LEASE_MS", 60_000),
      dbPath: process.env.SKYCLAW_DB_PATH || ".skyclaw/coordinator.db",
      nodeId: process.env.SKYCLAW_COORDINATOR_NODE_ID,
      publicUrl: process.env.SKYCLAW_COORDINATOR_PUBLIC_URL,
      peerUrls,
      peerSyncIntervalMs: parseIntEnv("SKYCLAW_PEER_SYNC_MS", 3_000),
      minReplicas: parseIntEnv("SKYCLAW_MIN_REPLICATIONS", 2),
      idempotencyTtlMs: parseIntEnv("SKYCLAW_IDEMPOTENCY_TTL_MS", 86_400_000),
      peerDiscoveryEnabled: process.env.SKYCLAW_PEER_DISCOVERY !== "0",
      publicApiKeys: parsePublicApiKeysFromEnv(),
      publicCorsOrigin: process.env.SKYCLAW_PUBLIC_CORS_ORIGIN
    });
    return;
  }

  if (command === "host") {
    await startHostDaemon(hostConfigFromEnv());
    return;
  }

  if (command === "gateway") {
    const coordinatorUrls = parseCoordinatorUrlsFromEnv();
    await startGatewayServer(gatewayConfigFromEnv(coordinatorUrls));
    return;
  }

  const coordinatorUrls = parseCoordinatorUrlsFromEnv();
  const token = process.env.SKYCLAW_TOKEN;
  const client = new CoordinatorClient(coordinatorUrls, token);

  if (command === "enqueue-shell") {
    const [shellCommand, ...shellArgs] = args;
    if (!shellCommand) {
      throw new Error("enqueue-shell requires a command");
    }
    const response = await client.postJson("/v1/jobs", {
      payload: {
        kind: "shell",
        command: shellCommand,
        args: shellArgs
      },
      requirement: {
        requiredCapabilities: ["shell"]
      }
    });
    process.stdout.write(`${response.job.id}\n`);
    return;
  }

  if (command === "enqueue-openclaw") {
    const response = await client.postJson("/v1/jobs", {
      payload: {
        kind: "openclaw-run",
        args
      },
      requirement: {
        requiredCapabilities: ["openclaw"]
      }
    });
    process.stdout.write(`${response.job.id}\n`);
    return;
  }

  if (command === "deploy-service") {
    const [name, serviceCommand, ...serviceArgs] = args;
    if (!name || !serviceCommand) {
      throw new Error("deploy-service requires <name> <command> [args...]");
    }
    const response = await client.postJson("/v1/services", {
      name,
      command: serviceCommand,
      args: serviceArgs,
      requiredCapabilities: ["service-host"],
      replicas: 1
    });
    process.stdout.write(`${response.service.id}\n`);
    return;
  }

  if (command === "list-services") {
    const response = await client.getJson("/v1/services");
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[skyclaw] ${msg}\n`);
  process.exitCode = 1;
});
