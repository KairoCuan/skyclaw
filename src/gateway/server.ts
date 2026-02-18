import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceRecord } from "../types.js";
import { parseIntEnv } from "../util.js";
import { GatewayRegistry } from "./registry.js";

export interface GatewayServerOptions {
  port: number;
  host?: string;
  coordinatorUrls: string[];
  token?: string;
  refreshMs?: number;
  healthProbeMs?: number;
  healthPath?: string;
  healthTimeoutMs?: number;
  retryAttempts?: number;
  unhealthyCooldownMs?: number;
}

class CoordinatorClient {
  private activeIndex = 0;

  constructor(
    private readonly urls: string[],
    private readonly token?: string
  ) {}

  async getServices(): Promise<ServiceRecord[]> {
    let lastError: unknown;

    for (let i = 0; i < this.urls.length; i += 1) {
      const index = (this.activeIndex + i) % this.urls.length;
      const baseUrl = this.urls[index];
      try {
        const response = await fetch(`${baseUrl}/v1/services`, {
          headers: {
            ...(this.token ? { "x-skyclaw-token": this.token } : {})
          }
        });
        if (!response.ok) {
          throw new Error(`request failed (${response.status}): ${await response.text()}`);
        }
        const payload = (await response.json()) as { services?: ServiceRecord[] };
        this.activeIndex = index;
        return payload.services || [];
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("all coordinators unavailable");
  }
}

export async function startGatewayServer(options: GatewayServerOptions): Promise<void> {
  if (options.coordinatorUrls.length === 0) {
    throw new Error("at least one coordinator URL is required for gateway");
  }

  const registry = new GatewayRegistry({ unhealthyCooldownMs: options.unhealthyCooldownMs });
  const client = new CoordinatorClient(options.coordinatorUrls, options.token);
  const retryAttempts = Math.max(0, options.retryAttempts ?? 1);
  const healthPath = options.healthPath || "/health";
  const healthTimeoutMs = Math.max(500, options.healthTimeoutMs ?? 1_500);

  const refresh = async () => {
    try {
      const services = await client.getServices();
      registry.updateFromServices(services);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[skyclaw] gateway refresh failed: ${msg}\n`);
    }
  };

  await refresh();
  setInterval(() => {
    void refresh();
  }, options.refreshMs ?? 3_000).unref();
  setInterval(() => {
    void probeEndpoints(registry, healthPath, healthTimeoutMs);
  }, options.healthProbeMs ?? 5_000).unref();

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        sendJson(res, 400, { error: "invalid request" });
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const { pathname, search } = url;

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true, services: registry.listServiceKeys() });
        return;
      }

      const match = pathname.match(/^\/v1\/gateway\/([^/]+)(\/.*)?$/);
      if (!match) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      const serviceKey = decodeURIComponent(match[1]);
      const servicePath = match[2] || "/";
      const method = req.method.toUpperCase();
      const attempts = isRetryableMethod(method) ? retryAttempts + 1 : 1;
      const targetBases = registry.nextEndpoints(serviceKey, attempts);
      if (targetBases.length === 0) {
        sendJson(res, 503, { error: `no healthy endpoints for service ${serviceKey}` });
        return;
      }
      const bodyBuffer = await readBody(req);
      let lastError: Error | undefined;
      let lastUpstream: Response | undefined;

      for (const targetBase of targetBases) {
        const targetUrl = `${targetBase}${servicePath}${search}`;
        try {
          const upstream = await fetch(targetUrl, {
            method,
            headers: filterRequestHeaders(req.headers),
            body: bodyBuffer.length > 0 ? new Uint8Array(bodyBuffer) : undefined
          });

          if (upstream.status >= 500 && targetBase !== targetBases[targetBases.length - 1]) {
            registry.markEndpointFailure(targetBase);
            lastUpstream = upstream;
            continue;
          }

          if (upstream.status >= 500) {
            registry.markEndpointFailure(targetBase);
          } else {
            registry.markEndpointSuccess(targetBase);
          }

          res.statusCode = upstream.status;
          upstream.headers.forEach((value, key) => {
            if (key.toLowerCase() === "transfer-encoding") return;
            res.setHeader(key, value);
          });
          const out = Buffer.from(await upstream.arrayBuffer());
          res.end(out);
          return;
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error(String(error));
          lastError = wrapped;
          registry.markEndpointFailure(targetBase);
        }
      }

      if (lastUpstream) {
        res.statusCode = lastUpstream.status;
        lastUpstream.headers.forEach((value, key) => {
          if (key.toLowerCase() === "transfer-encoding") return;
          res.setHeader(key, value);
        });
        res.end(Buffer.from(await lastUpstream.arrayBuffer()));
        return;
      }

      throw lastError || new Error("upstream request failed");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "gateway error";
      sendJson(res, 502, { error: msg });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host ?? "0.0.0.0", () => resolve());
  });

  process.stdout.write(
    `[skyclaw] gateway listening on http://${options.host ?? "0.0.0.0"}:${options.port}\n`
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function filterRequestHeaders(headers: IncomingMessage["headers"]): Headers {
  const filtered = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "content-length") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const v of value) filtered.append(key, v);
    } else {
      filtered.set(key, value);
    }
  }
  return filtered;
}

export function gatewayConfigFromEnv(coordinatorUrls: string[]): GatewayServerOptions {
  return {
    coordinatorUrls,
    token: process.env.SKYCLAW_TOKEN,
    host: process.env.SKYCLAW_GATEWAY_HOST || "0.0.0.0",
    port: parseIntEnv("SKYCLAW_GATEWAY_PORT", 8790),
    refreshMs: parseIntEnv("SKYCLAW_GATEWAY_REFRESH_MS", 3_000),
    healthProbeMs: parseIntEnv("SKYCLAW_GATEWAY_HEALTH_PROBE_MS", 5_000),
    healthPath: process.env.SKYCLAW_GATEWAY_HEALTH_PATH || "/health",
    healthTimeoutMs: parseIntEnv("SKYCLAW_GATEWAY_HEALTH_TIMEOUT_MS", 1_500),
    retryAttempts: parseIntEnv("SKYCLAW_GATEWAY_RETRY_ATTEMPTS", 1),
    unhealthyCooldownMs: parseIntEnv("SKYCLAW_GATEWAY_UNHEALTHY_COOLDOWN_MS", 10_000)
  };
}

async function probeEndpoints(
  registry: GatewayRegistry,
  healthPath: string,
  timeoutMs: number
): Promise<void> {
  const endpoints = registry.listAllEndpoints();
  await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const response = await fetchWithTimeout(`${endpoint}${healthPath}`, timeoutMs, "GET");
        if (response.ok) {
          registry.markEndpointSuccess(endpoint);
        } else {
          registry.markEndpointFailure(endpoint);
        }
      } catch {
        registry.markEndpointFailure(endpoint);
      }
    })
  );
}

async function fetchWithTimeout(url: string, timeoutMs: number, method: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
