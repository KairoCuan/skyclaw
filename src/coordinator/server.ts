import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type {
  CompleteJobRequest,
  CoordinatorSnapshot,
  EnqueueJobRequest,
  HeartbeatRequest,
  JobRecord,
  PublicSubmitJobRequest,
  RegisterHostRequest,
  ServiceDeployRequest,
  ServiceReportRequest
} from "../types.js";
import { readJson, sendError, sendJson } from "../http.js";
import { normalizeMinReplicas, requiredPeerReplications } from "./replication-policy.js";
import { CoordinatorState } from "./state.js";

export interface CoordinatorServerOptions {
  port: number;
  host?: string;
  authToken?: string;
  leaseMs?: number;
  dbPath?: string;
  nodeId?: string;
  peerUrls?: string[];
  peerSyncIntervalMs?: number;
  minReplicas?: number;
  idempotencyTtlMs?: number;
  publicUrl?: string;
  peerDiscoveryEnabled?: boolean;
  publicApiKeys?: PublicApiKey[];
  publicCorsOrigin?: string;
}

export interface PublicApiKey {
  key: string;
  label?: string;
  allowedCapabilities?: string[];
  allowShell?: boolean;
}

function checkAuth(reqToken: string | undefined, configured: string | undefined): boolean {
  if (!configured) return true;
  return reqToken === configured;
}

function normalizeOrigin(origin: string | undefined): string {
  const trimmed = origin?.trim();
  return trimmed ? trimmed : "*";
}

function setCorsHeaders(res: import("node:http").ServerResponse, origin: string): void {
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization,x-api-key,x-idempotency-key");
}

function readBearerOrApiKey(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  const rawAuth = Array.isArray(authorization) ? authorization[0] : authorization;
  if (rawAuth?.startsWith("Bearer ")) {
    const value = rawAuth.slice("Bearer ".length).trim();
    if (value) return value;
  }
  const apiKeyHeader = req.headers["x-api-key"];
  const rawApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const candidate = rawApiKey?.trim();
  return candidate || undefined;
}

function resolvePublicApiKey(
  req: IncomingMessage,
  rules: PublicApiKey[]
): PublicApiKey | undefined {
  if (rules.length === 0) return undefined;
  const key = readBearerOrApiKey(req);
  if (!key) return undefined;
  return rules.find((rule) => rule.key === key);
}

function normalizeBaseUrl(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const normalized = new URL(url.trim());
    const pathname = normalized.pathname === "/" ? "" : normalized.pathname.replace(/\/$/, "");
    return `${normalized.protocol}//${normalized.host}${pathname}`;
  } catch {
    return undefined;
  }
}

function buildInitialPeerSet(urls: string[] | undefined, selfUrl: string | undefined): Set<string> {
  const peers = new Set<string>();
  for (const raw of urls || []) {
    const normalized = normalizeBaseUrl(raw);
    if (!normalized) continue;
    if (normalized === selfUrl) continue;
    peers.add(normalized);
  }
  return peers;
}

export async function startCoordinatorServer(options: CoordinatorServerOptions): Promise<void> {
  const minReplicas = normalizeMinReplicas(options.minReplicas);
  const requiredPeerAcks = requiredPeerReplications(minReplicas);
  const state = new CoordinatorState({
    leaseMs: options.leaseMs,
    dbPath: options.dbPath,
    nodeId: options.nodeId
  });

  const peerDiscoveryEnabled = options.peerDiscoveryEnabled ?? true;
  const selfPublicUrl = normalizeBaseUrl(options.publicUrl);
  const peerSet = buildInitialPeerSet(options.peerUrls, selfPublicUrl);
  const idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
  const publicApiKeys = options.publicApiKeys ?? [];
  const publicCorsOrigin = normalizeOrigin(options.publicCorsOrigin);

  setInterval(() => {
    state.requeueExpiredLeases();
  }, 1_000).unref();

  setInterval(() => {
    state.purgeExpiredIdempotency();
  }, 60_000).unref();

  const syncIntervalMs = options.peerSyncIntervalMs ?? 3_000;
  setInterval(() => {
    const peers = [...peerSet.values()];
    if (peers.length > 0) {
      void syncFromPeers(state, peers, options.authToken);
    }
    if (peerDiscoveryEnabled) {
      void discoverPeers(peerSet, peers, options.authToken, selfPublicUrl);
    }
  }, syncIntervalMs).unref();

  const server = createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        sendError(res, 400, "invalid request");
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const { pathname } = url;
      const isPublicApiRoute = pathname === "/v1/public/jobs" || pathname.startsWith("/v1/public/jobs/");

      if (isPublicApiRoute) {
        setCorsHeaders(res, publicCorsOrigin);
      }

      if (req.method === "OPTIONS" && isPublicApiRoute) {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (isPublicApiRoute) {
        if (publicApiKeys.length === 0) {
          sendError(res, 503, "public api is disabled");
          return;
        }
      } else {
        const token = req.headers["x-skyclaw-token"];
        const providedToken = Array.isArray(token) ? token[0] : token;
        if (!checkAuth(providedToken, options.authToken)) {
          sendError(res, 401, "unauthorized");
          return;
        }
      }

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true, nodeId: state.getNodeId() });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/network/peers") {
        sendJson(res, 200, {
          nodeId: state.getNodeId(),
          self: selfPublicUrl,
          peers: [...peerSet.values()]
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/network/join") {
        const body = await readJson<{ url?: string }>(req);
        const candidate = normalizeBaseUrl(body.url);
        if (!candidate) {
          sendError(res, 400, "url is required");
          return;
        }
        if (candidate !== selfPublicUrl) {
          peerSet.add(candidate);
        }
        sendJson(res, 200, {
          ok: true,
          nodeId: state.getNodeId(),
          self: selfPublicUrl,
          peers: [...peerSet.values()]
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/state") {
        sendJson(res, 200, state.snapshot());
        return;
      }

      if (req.method === "POST" && pathname === "/v1/replicate/snapshot") {
        const snapshot = await readJson<CoordinatorSnapshot>(req);
        const merged = state.mergeSnapshot(snapshot);
        sendJson(res, 200, { ok: true, changed: merged.changed, nodeId: state.getNodeId() });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/hosts/register") {
        const body = await readJson<RegisterHostRequest>(req);
        if (!body.name?.trim()) {
          sendError(res, 400, "name is required");
          return;
        }
        const applied = await applyIdempotentMutation(
          req,
          state,
          "/v1/hosts/register",
          body,
          idempotencyTtlMs,
          () =>
            applyMutationWithQuorum(
              state,
              [...peerSet.values()],
              options.authToken,
              requiredPeerAcks,
              () => state.registerHost(body)
            ),
          (host) => ({ host })
        );
        if (applied.kind === "conflict") {
          sendError(res, 409, applied.error);
          return;
        }
        if (applied.kind === "error") {
          sendError(res, 503, applied.error);
          return;
        }
        sendJson(res, applied.statusCode, applied.body);
        return;
      }

      const heartbeatMatch = pathname.match(/^\/v1\/hosts\/([^/]+)\/heartbeat$/);
      if (req.method === "POST" && heartbeatMatch) {
        const hostId = decodeURIComponent(heartbeatMatch[1]);
        const body = await readJson<HeartbeatRequest>(req);
        const route = `/v1/hosts/${hostId}/heartbeat`;
        const applied = await applyIdempotentMutation(
          req,
          state,
          route,
          body,
          idempotencyTtlMs,
          () =>
            applyMutationWithQuorum(
              state,
              [...peerSet.values()],
              options.authToken,
              requiredPeerAcks,
              () => state.heartbeat(hostId, body.activeLeases)
            ),
          (host) => ({ host })
        );
        if (applied.kind === "conflict") {
          sendError(res, 409, applied.error);
          return;
        }
        if (applied.kind === "error") {
          sendError(res, 503, applied.error);
          return;
        }
        sendJson(res, applied.statusCode, applied.body);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/jobs") {
        const body = await readJson<EnqueueJobRequest>(req);
        if (!body.payload || !body.payload.kind) {
          sendError(res, 400, "payload is required");
          return;
        }
        const applied = await applyIdempotentMutation(
          req,
          state,
          "/v1/jobs",
          body,
          idempotencyTtlMs,
          () =>
            applyMutationWithQuorum(
              state,
              [...peerSet.values()],
              options.authToken,
              requiredPeerAcks,
              () => state.enqueueJob(body)
            ),
          (job) => ({ job })
        );
        if (applied.kind === "conflict") {
          sendError(res, 409, applied.error);
          return;
        }
        if (applied.kind === "error") {
          sendError(res, 503, applied.error);
          return;
        }
        sendJson(res, applied.statusCode, applied.body);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/services") {
        const body = await readJson<ServiceDeployRequest>(req);
        if (!body.name?.trim()) {
          sendError(res, 400, "name is required");
          return;
        }
        if (!body.command?.trim()) {
          sendError(res, 400, "command is required");
          return;
        }
        const applied = await applyIdempotentMutation(
          req,
          state,
          "/v1/services",
          body,
          idempotencyTtlMs,
          () =>
            applyMutationWithQuorum(
              state,
              [...peerSet.values()],
              options.authToken,
              requiredPeerAcks,
              () => state.deployService(body)
            ),
          (service) => ({ service })
        );
        if (applied.kind === "conflict") {
          sendError(res, 409, applied.error);
          return;
        }
        if (applied.kind === "error") {
          sendError(res, 503, applied.error);
          return;
        }
        sendJson(res, applied.statusCode, applied.body);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/services") {
        sendJson(res, 200, { services: state.listServices() });
        return;
      }

      const serviceGetMatch = pathname.match(/^\/v1\/services\/([^/]+)$/);
      if (req.method === "GET" && serviceGetMatch) {
        const serviceId = decodeURIComponent(serviceGetMatch[1]);
        const service = state.getService(serviceId);
        if (!service) {
          sendError(res, 404, "service not found");
          return;
        }
        sendJson(res, 200, { service });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/public/jobs") {
        const apiKey = resolvePublicApiKey(req, publicApiKeys);
        if (!apiKey) {
          sendError(res, 401, "invalid api key");
          return;
        }

        const body = await readJson<PublicSubmitJobRequest>(req);
        if (!body.payload || !body.payload.kind) {
          sendError(res, 400, "payload is required");
          return;
        }

        const allowedCapabilities = apiKey.allowedCapabilities?.length
          ? apiKey.allowedCapabilities
          : ["openclaw"];
        const requestedCapabilities = body.requirement?.requiredCapabilities ?? [];
        if (!requestedCapabilities.every((cap) => allowedCapabilities.includes(cap))) {
          sendError(res, 403, "requested capabilities are not allowed for this api key");
          return;
        }

        if (body.payload.kind === "shell" && !apiKey.allowShell) {
          sendError(res, 403, "shell jobs are not allowed for this api key");
          return;
        }

        const enqueueRequest: EnqueueJobRequest = {
          payload: body.payload,
          requirement: body.requirement ?? { requiredCapabilities: allowedCapabilities },
          submittedBy: toPublicSubmitterId(apiKey)
        };

        const applied = await applyIdempotentMutation(
          req,
          state,
          "/v1/public/jobs",
          enqueueRequest,
          idempotencyTtlMs,
          () =>
            applyMutationWithQuorum(
              state,
              [...peerSet.values()],
              options.authToken,
              requiredPeerAcks,
              () => state.enqueueJob(enqueueRequest)
            ),
          (job) => ({ job: toPublicJobResponse(job) })
        );
        if (applied.kind === "conflict") {
          sendError(res, 409, applied.error);
          return;
        }
        if (applied.kind === "error") {
          sendError(res, 503, applied.error);
          return;
        }
        sendJson(res, applied.statusCode, applied.body);
        return;
      }

      const publicJobMatch = pathname.match(/^\/v1\/public\/jobs\/([^/]+)$/);
      if (req.method === "GET" && publicJobMatch) {
        const apiKey = resolvePublicApiKey(req, publicApiKeys);
        if (!apiKey) {
          sendError(res, 401, "invalid api key");
          return;
        }
        const jobId = decodeURIComponent(publicJobMatch[1]);
        const job = state.getJob(jobId);
        if (!job) {
          sendError(res, 404, "job not found");
          return;
        }
        if (job.submittedBy !== toPublicSubmitterId(apiKey)) {
          sendError(res, 404, "job not found");
          return;
        }
        sendJson(res, 200, { job: toPublicJobResponse(job) });
        return;
      }

      const serviceClaimMatch = pathname.match(/^\/v1\/hosts\/([^/]+)\/services\/claim$/);
      if (req.method === "POST" && serviceClaimMatch) {
        const hostId = decodeURIComponent(serviceClaimMatch[1]);
        const claimBody = await readJson<Record<string, unknown>>(req);
        const route = `/v1/hosts/${hostId}/services/claim`;
        const applied = await applyIdempotentMutation(
          req,
          state,
          route,
          claimBody,
          idempotencyTtlMs,
          () =>
            applyMutationWithQuorum(
              state,
              [...peerSet.values()],
              options.authToken,
              requiredPeerAcks,
              () => state.claimService(hostId)
            ),
          (claimResponse) => claimResponse
        );
        if (applied.kind === "conflict") {
          sendError(res, 409, applied.error);
          return;
        }
        if (applied.kind === "error") {
          sendError(res, 503, applied.error);
          return;
        }
        sendJson(res, applied.statusCode, applied.body);
        return;
      }

      const serviceReportMatch = pathname.match(/^\/v1\/services\/([^/]+)\/report$/);
      if (req.method === "POST" && serviceReportMatch) {
        const serviceId = decodeURIComponent(serviceReportMatch[1]);
        const body = await readJson<ServiceReportRequest>(req);
        const applied = await applyIdempotentMutation(
          req,
          state,
          `/v1/services/${serviceId}/report`,
          body,
          idempotencyTtlMs,
          () =>
            applyMutationWithQuorum(
              state,
              [...peerSet.values()],
              options.authToken,
              requiredPeerAcks,
              () => state.reportService(serviceId, body)
            ),
          (service) => ({ service })
        );
        if (applied.kind === "conflict") {
          sendError(res, 409, applied.error);
          return;
        }
        if (applied.kind === "error") {
          sendError(res, 503, applied.error);
          return;
        }
        sendJson(res, applied.statusCode, applied.body);
        return;
      }

      const claimMatch = pathname.match(/^\/v1\/hosts\/([^/]+)\/claim$/);
      if (req.method === "POST" && claimMatch) {
        const hostId = decodeURIComponent(claimMatch[1]);
        const claimBody = await readJson<Record<string, unknown>>(req);
        const route = `/v1/hosts/${hostId}/claim`;
        const applied = await applyIdempotentMutation(
          req,
          state,
          route,
          claimBody,
          idempotencyTtlMs,
          () =>
            applyMutationWithQuorum(
              state,
              [...peerSet.values()],
              options.authToken,
              requiredPeerAcks,
              () => state.claimJob(hostId)
            ),
          (claimResponse) => claimResponse
        );
        if (applied.kind === "conflict") {
          sendError(res, 409, applied.error);
          return;
        }
        if (applied.kind === "error") {
          sendError(res, 503, applied.error);
          return;
        }
        sendJson(res, applied.statusCode, applied.body);
        return;
      }

      const completeMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/complete$/);
      if (req.method === "POST" && completeMatch) {
        const jobId = decodeURIComponent(completeMatch[1]);
        const body = await readJson<CompleteJobRequest>(req);
        const applied = await applyIdempotentMutation(
          req,
          state,
          `/v1/jobs/${jobId}/complete`,
          body,
          idempotencyTtlMs,
          () =>
            applyMutationWithQuorum(
              state,
              [...peerSet.values()],
              options.authToken,
              requiredPeerAcks,
              () => state.completeJob(jobId, body)
            ),
          (job) => ({ job })
        );
        if (applied.kind === "conflict") {
          sendError(res, 409, applied.error);
          return;
        }
        if (applied.kind === "error") {
          sendError(res, 503, applied.error);
          return;
        }
        sendJson(res, applied.statusCode, applied.body);
        return;
      }

      sendError(res, 404, "not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal error";
      sendError(res, 500, message);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host ?? "0.0.0.0", () => resolve());
  });

  process.stdout.write(
    `[skyclaw] coordinator ${state.getNodeId()} listening on http://${options.host ?? "0.0.0.0"}:${options.port}\n`
  );
  process.stdout.write(
    `[skyclaw] replication policy: min replicas ${minReplicas} (${requiredPeerAcks} peer acks required)\n`
  );

  if (selfPublicUrl) {
    process.stdout.write(`[skyclaw] public url: ${selfPublicUrl}\n`);
  }

  if (peerSet.size > 0) {
    process.stdout.write(`[skyclaw] peers: ${[...peerSet.values()].join(", ")}\n`);
    void syncFromPeers(state, [...peerSet.values()], options.authToken);
    if (peerDiscoveryEnabled) {
      void discoverPeers(peerSet, [...peerSet.values()], options.authToken, selfPublicUrl);
    }
  }
}

async function replicateSnapshotToPeers(
  state: CoordinatorState,
  peerUrls: string[],
  token?: string
): Promise<{ acked: number; attempted: number }> {
  if (peerUrls.length === 0) return { acked: 0, attempted: 0 };
  const snapshot = state.snapshot();
  const results = await Promise.all(
    peerUrls.map(async (peerUrl) => {
      try {
        const response = await fetch(`${peerUrl}/v1/replicate/snapshot`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { "x-skyclaw-token": token } : {})
          },
          body: JSON.stringify(snapshot)
        });
        return response.ok;
      } catch {
        return false;
      }
    })
  );
  return { acked: results.filter(Boolean).length, attempted: peerUrls.length };
}

async function applyMutationWithQuorum<T>(
  state: CoordinatorState,
  peerUrls: string[],
  token: string | undefined,
  requiredPeerAcks: number,
  mutate: () => T
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  if (peerUrls.length < requiredPeerAcks) {
    return {
      ok: false,
      error: `insufficient peers: requires at least ${requiredPeerAcks} known peers, got ${peerUrls.length}`
    };
  }

  const checkpoint = state.checkpoint();
  try {
    const value = mutate();
    const replication = await replicateSnapshotToPeers(state, peerUrls, token);
    if (replication.acked < requiredPeerAcks) {
      state.restore(checkpoint);
      return {
        ok: false,
        error: `replication target not met: required ${requiredPeerAcks} peer acks, got ${replication.acked}`
      };
    }
    return { ok: true, value };
  } catch (error) {
    state.restore(checkpoint);
    throw error;
  }
}

async function applyIdempotentMutation<T>(
  req: IncomingMessage,
  state: CoordinatorState,
  route: string,
  requestBody: unknown,
  ttlMs: number,
  mutate: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
  toResponseBody: (value: T) => unknown
): Promise<
  | { kind: "ok"; statusCode: number; body: unknown }
  | { kind: "error"; error: string }
  | { kind: "conflict"; error: string }
> {
  const key = readIdempotencyKey(req);
  if (!key) {
    const result = await mutate();
    if (!result.ok) return { kind: "error", error: result.error };
    return { kind: "ok", statusCode: 200, body: toResponseBody(result.value) };
  }

  const requestHash = hashIdempotencyRequest(route, requestBody);
  const existing = state.getIdempotency(route, key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return {
        kind: "conflict",
        error: `idempotency key reuse conflict for route ${route}`
      };
    }
    return {
      kind: "ok",
      statusCode: existing.statusCode,
      body: JSON.parse(existing.responseJson)
    };
  }

  const result = await mutate();
  if (!result.ok) return { kind: "error", error: result.error };

  const body = toResponseBody(result.value);
  state.saveIdempotency(route, key, requestHash, 200, body, ttlMs);
  return { kind: "ok", statusCode: 200, body };
}

function readIdempotencyKey(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  const value = key?.trim();
  return value ? value : undefined;
}

function hashIdempotencyRequest(route: string, body: unknown): string {
  const canonical = stableStringify(body);
  return createHash("sha256").update(`${route}\n${canonical}`).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const out: Record<string, unknown> = {};
    for (const [key, nested] of entries) {
      out[key] = sortJsonValue(nested);
    }
    return out;
  }
  return value;
}

function toPublicSubmitterId(apiKey: PublicApiKey): string {
  return `public:${apiKey.label || "anonymous"}`;
}

function toPublicJobResponse(job: JobRecord): Omit<JobRecord, "submittedBy"> {
  const { submittedBy: _submittedBy, ...rest } = job;
  return rest;
}

async function syncFromPeers(state: CoordinatorState, peerUrls: string[], token?: string): Promise<void> {
  await Promise.all(
    peerUrls.map(async (peerUrl) => {
      try {
        const response = await fetch(`${peerUrl}/v1/state`, {
          headers: {
            ...(token ? { "x-skyclaw-token": token } : {})
          }
        });
        if (!response.ok) return;
        const snapshot = (await response.json()) as CoordinatorSnapshot;
        state.mergeSnapshot(snapshot);
      } catch {
        return;
      }
    })
  );
}

async function discoverPeers(
  peerSet: Set<string>,
  seedPeers: string[],
  token: string | undefined,
  selfPublicUrl: string | undefined
): Promise<void> {
  await Promise.all(
    seedPeers.map(async (peerUrl) => {
      try {
        const peersResponse = await fetch(`${peerUrl}/v1/network/peers`, {
          headers: {
            ...(token ? { "x-skyclaw-token": token } : {})
          }
        });
        if (peersResponse.ok) {
          const payload = (await peersResponse.json()) as { peers?: string[]; self?: string };
          const candidates = [...(payload.peers || []), payload.self || ""];
          for (const candidate of candidates) {
            const normalized = normalizeBaseUrl(candidate);
            if (!normalized) continue;
            if (normalized === selfPublicUrl) continue;
            peerSet.add(normalized);
          }
        }

        if (selfPublicUrl) {
          await fetch(`${peerUrl}/v1/network/join`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token ? { "x-skyclaw-token": token } : {})
            },
            body: JSON.stringify({ url: selfPublicUrl })
          });
        }
      } catch {
        return;
      }
    })
  );
}
