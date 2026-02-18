import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type {
  CompleteJobRequest,
  CoordinatorSnapshot,
  EnqueueJobRequest,
  HeartbeatRequest,
  RegisterHostRequest
} from "../types.js";
import { readJson, sendError, sendJson } from "../http.js";
import {
  assertPeerCapacity,
  normalizeMinReplicas,
  requiredPeerReplications
} from "./replication-policy.js";
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
}

function checkAuth(reqToken: string | undefined, configured: string | undefined): boolean {
  if (!configured) return true;
  return reqToken === configured;
}

function normalizePeerUrls(urls: string[] | undefined, ownPort: number): string[] {
  if (!urls?.length) return [];
  const ownLocal = new Set([
    `http://127.0.0.1:${ownPort}`,
    `http://localhost:${ownPort}`,
    `http://0.0.0.0:${ownPort}`
  ]);
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))].filter((url) => !ownLocal.has(url));
}

export async function startCoordinatorServer(options: CoordinatorServerOptions): Promise<void> {
  const minReplicas = normalizeMinReplicas(options.minReplicas);
  const requiredPeerAcks = requiredPeerReplications(minReplicas);
  const state = new CoordinatorState({
    leaseMs: options.leaseMs,
    dbPath: options.dbPath,
    nodeId: options.nodeId
  });
  const peerUrls = normalizePeerUrls(options.peerUrls, options.port);
  const idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
  assertPeerCapacity(minReplicas, peerUrls.length);

  setInterval(() => {
    state.requeueExpiredLeases();
  }, 1_000).unref();
  setInterval(() => {
    state.purgeExpiredIdempotency();
  }, 60_000).unref();

  if (peerUrls.length > 0) {
    const syncIntervalMs = options.peerSyncIntervalMs ?? 3_000;
    setInterval(() => {
      void syncFromPeers(state, peerUrls, options.authToken);
    }, syncIntervalMs).unref();
  }

  const server = createServer(async (req, res) => {
    try {
      const token = req.headers["x-skyclaw-token"];
      const providedToken = Array.isArray(token) ? token[0] : token;
      if (!checkAuth(providedToken, options.authToken)) {
        sendError(res, 401, "unauthorized");
        return;
      }

      if (!req.url || !req.method) {
        sendError(res, 400, "invalid request");
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true, nodeId: state.getNodeId() });
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
              peerUrls,
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
              peerUrls,
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
              peerUrls,
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
              peerUrls,
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
              peerUrls,
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

  if (peerUrls.length > 0) {
    process.stdout.write(`[skyclaw] peers: ${peerUrls.join(", ")}\n`);
    void syncFromPeers(state, peerUrls, options.authToken);
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
