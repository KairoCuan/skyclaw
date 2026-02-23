# Skyclaw (KairoCuan Fork)

Decentralized orchestration layer for autonomous agent workloads on the [KairoCuan](https://github.com/KairoCuan) ecosystem.

Forked from [CharlieGreenman/skyclaw](https://github.com/CharlieGreenman/skyclaw) at commit `b61212c` (2026-02-17).

## Why This Fork

The upstream SkyClaw project provides a lightweight coordinator/worker mesh for OpenClaw compute jobs. This fork adapts it for **agent-first DeFi infrastructure** — specifically as the orchestration layer (Layer 0) for KairoCuan trading agents running on the Jalikan DEX protocol.

**What this fork adds (planned):**

- Container isolation via Podman for agent workloads handling real tokens
- `jalikan-trading` capability for hosts with RPC endpoints and contract ABIs
- Job TTL and pruning to prevent unbounded state growth
- Per-host authentication (replacing shared token for production)
- Integration points for x402 billing and inference gateway services

**What upstream provides (unchanged):**

- Coordinator cluster with SQLite persistence and crash recovery
- Quorum writes with checkpoint/rollback
- Host daemon with capability-based job matching
- Service deployment with health-aware gateway routing
- Dynamic peer discovery via gossip protocol
- Idempotent mutations and multi-coordinator client failover

## Architecture

```
Layer 3: Agent Runtime (Automaton / KairoCuan)
  └── Runs INSIDE containers on SkyClaw hosts

Layer 2: Platform Services (deployed AS SkyClaw services)
  ├── Inference gateway (vLLM/LiteLLM)
  ├── Billing adapter (x402/escrow)
  └── Jalikan Discovery API

Layer 1: Isolation (this fork adds)
  └── Podman rootless containers, per-agent cgroups

Layer 0: Orchestration (SkyClaw core)
  ├── Coordinator cluster (job queue, state replication)
  ├── Host daemons (claim + execute jobs/services)
  └── Federated gateways (route traffic to services)
```

## Quick Start

### 1. Start coordinator

```bash
export SKYCLAW_TOKEN=change-me
export SKYCLAW_COORDINATOR_NODE_ID=node-a
export SKYCLAW_COORDINATOR_PORT=8787
export SKYCLAW_COORDINATOR_PUBLIC_URL=http://127.0.0.1:8787
export SKYCLAW_MIN_REPLICATIONS=2
export SKYCLAW_DB_PATH=.skyclaw/node-a.db
node dist/cli.js coordinator
```

For multi-node setup, add peer URLs:

```bash
export SKYCLAW_PEER_URLS=http://127.0.0.1:8788
```

### 2. Start a host

```bash
export SKYCLAW_TOKEN=change-me
export SKYCLAW_COORDINATOR_URLS=http://127.0.0.1:8787
export SKYCLAW_CAPABILITIES=shell,openclaw,service-host
export SKYCLAW_ALLOWED_COMMANDS=openclaw,node,bash,sh,npm,pnpm
node dist/cli.js host
```

### 3. Submit work

```bash
# Shell job
node dist/cli.js enqueue-shell bash -lc "echo hello"

# OpenClaw job
node dist/cli.js enqueue-openclaw run

# Deploy a long-lived service
node dist/cli.js deploy-service my-api node dist/server.js

# List services
node dist/cli.js list-services
```

### 4. Start a gateway (optional)

```bash
export SKYCLAW_COORDINATOR_URLS=http://127.0.0.1:8787
export SKYCLAW_GATEWAY_PORT=8790
node dist/cli.js gateway
```

Route traffic through gateway:

```bash
curl http://127.0.0.1:8790/v1/gateway/my-api/health
```

## API Surface

### Core (shared-token auth via `x-skyclaw-token`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/hosts/register` | Register a host |
| POST | `/v1/hosts/:id/heartbeat` | Host heartbeat |
| POST | `/v1/hosts/:id/claim` | Claim a job |
| POST | `/v1/jobs` | Enqueue a job |
| POST | `/v1/jobs/:id/complete` | Report job completion |
| POST | `/v1/services` | Deploy a service |
| GET | `/v1/services` | List services |
| GET | `/v1/services/:id` | Get service details |
| POST | `/v1/hosts/:id/services/claim` | Claim a service |
| POST | `/v1/services/:id/report` | Report service status |
| POST | `/v1/replicate/snapshot` | Peer replication |
| GET | `/v1/network/peers` | List known peers |
| POST | `/v1/network/join` | Announce coordinator |
| GET | `/v1/state` | Full state snapshot |
| GET | `/health` | Health check |

### Public (API key auth via `Authorization: Bearer` or `x-api-key`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/public/jobs` | Submit job (scoped) |
| GET | `/v1/public/jobs/:id` | Poll job status |

### Gateway

| Method | Endpoint | Description |
|--------|----------|-------------|
| ANY | `/v1/gateway/:serviceName/*` | Route to service |

## Environment Variables

<details>
<summary>Full reference</summary>

### Coordinator

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYCLAW_COORDINATOR_PORT` | `8787` | Listen port |
| `SKYCLAW_COORDINATOR_HOST` | `0.0.0.0` | Bind address |
| `SKYCLAW_COORDINATOR_NODE_ID` | auto | Unique node identifier |
| `SKYCLAW_COORDINATOR_PUBLIC_URL` | — | Self-announce URL for peer discovery |
| `SKYCLAW_TOKEN` | — | Shared auth token |
| `SKYCLAW_PEER_URLS` | — | Comma-separated peer coordinator URLs |
| `SKYCLAW_MIN_REPLICATIONS` | `2` | Minimum replicas (requires N-1 peer ACKs) |
| `SKYCLAW_PEER_DISCOVERY` | `1` | Enable gossip-based peer discovery |
| `SKYCLAW_PEER_SYNC_MS` | `3000` | Peer sync interval |
| `SKYCLAW_DB_PATH` | `.skyclaw/coordinator.db` | SQLite database path |
| `SKYCLAW_LEASE_MS` | `60000` | Job lease timeout |
| `SKYCLAW_IDEMPOTENCY_TTL_MS` | `86400000` | Idempotency record TTL (24h) |
| `SKYCLAW_PUBLIC_API_KEYS` | — | Public API keys (`key:label:caps[:shell]`) |
| `SKYCLAW_PUBLIC_CORS_ORIGIN` | — | CORS origin for public routes |

### Host

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYCLAW_COORDINATOR_URL` | `http://127.0.0.1:8787` | Primary coordinator |
| `SKYCLAW_COORDINATOR_URLS` | — | Comma-separated coordinators (failover) |
| `SKYCLAW_CAPABILITIES` | `shell,openclaw,service-host` | Advertised capabilities |
| `SKYCLAW_ALLOWED_COMMANDS` | `openclaw,node,bash,sh,npm,pnpm` | Command allowlist |
| `SKYCLAW_OPENCLAW_COMMAND` | `openclaw` | OpenClaw binary name |
| `SKYCLAW_HOST_NAME` | auto | Host display name |
| `SKYCLAW_MAX_PARALLEL` | `1` | Max concurrent jobs |
| `SKYCLAW_SERVICE_HOST_ENABLED` | `1` | Enable service runtime |
| `SKYCLAW_SERVICE_BASE_PORT` | `3100` | Starting port for services |
| `SKYCLAW_SERVICE_HOST_PUBLIC_BASE_URL` | — | Reachable base URL for service endpoints |
| `SKYCLAW_TIMEOUT_MS` | `300000` | Default job timeout (5 min) |
| `SKYCLAW_MAX_OUTPUT_BYTES` | `131072` | Max captured stdout/stderr (128 KB) |

### Gateway

| Variable | Default | Description |
|----------|---------|-------------|
| `SKYCLAW_GATEWAY_PORT` | `8790` | Listen port |
| `SKYCLAW_GATEWAY_HOST` | `0.0.0.0` | Bind address |
| `SKYCLAW_GATEWAY_REFRESH_MS` | `3000` | Service discovery poll interval |
| `SKYCLAW_GATEWAY_HEALTH_PROBE_MS` | `5000` | Health probe interval |
| `SKYCLAW_GATEWAY_HEALTH_PATH` | `/health` | Health endpoint path |
| `SKYCLAW_GATEWAY_HEALTH_TIMEOUT_MS` | `1500` | Health probe timeout |
| `SKYCLAW_GATEWAY_RETRY_ATTEMPTS` | `1` | Retry count for idempotent requests |
| `SKYCLAW_GATEWAY_UNHEALTHY_COOLDOWN_MS` | `10000` | Cooldown before retrying unhealthy endpoint |

</details>

## Security (MVP)

- **Coordinator ↔ Host:** Shared token via `x-skyclaw-token` header
- **Public API:** Scoped API keys with capability restrictions
- **Host execution:** Command allowlist, per-job timeout, output truncation
- **No encryption, no mTLS, no process isolation** — MVP only

See [planned hardening](#why-this-fork) for production roadmap.

## Provenance

| | |
|---|---|
| **Upstream** | [CharlieGreenman/skyclaw](https://github.com/CharlieGreenman/skyclaw) |
| **Fork point** | Commit `b61212c` (2026-02-17) |
| **Original author** | Charlie Greenman (Razroo) |
| **License** | MIT |

## Related Projects

- [Jalikan](https://github.com/KairoCuan/jalikan) — Agent-first DEX protocol on Base L2
- [KairoCuan](https://github.com/KairoCuan) — Autonomous trading agents
- [Conway Research / Automaton](https://github.com/Conway-Research/automaton) — Sovereign AI agent runtime
- [Web4Indo](https://web4indo.org) — Web4 education platform (ID)