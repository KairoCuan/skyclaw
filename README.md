# Skyclaw

Skyclaw is a decentralized server network for OpenClaw that anyone can run.

It is heavily inspired by `automaton-skyclaw`, but re-targeted so OpenClaw users can join a shared compute network with their own nodes.

## What it does

- Runs coordinator nodes that replicate shared state across peers.
- Lets anyone run a host daemon and contribute OpenClaw execution capacity.
- Schedules jobs to hosts with matching capabilities.
- Persists queue state in SQLite with crash recovery.
- Supports idempotent writes and multi-coordinator client failover.
- Supports dynamic peer discovery for opt-in network growth.

## Architecture

- Coordinator cluster: job queue, host registry, leasing, replication.
- Host daemon: registers itself, heartbeats, claims jobs, executes OpenClaw work.
- Client CLI: enqueues shell/OpenClaw jobs and can target multiple coordinators.

## Install

```bash
# global install
npm install -g @razroo/skyclaw

# local development
npm install
npm run build
```

## Quick Start

1. Start coordinator A:

```bash
export SKYCLAW_TOKEN=change-me
export SKYCLAW_COORDINATOR_NODE_ID=node-a
export SKYCLAW_COORDINATOR_PORT=8787
export SKYCLAW_COORDINATOR_PUBLIC_URL=http://127.0.0.1:8787
export SKYCLAW_PEER_URLS=http://127.0.0.1:8788
export SKYCLAW_MIN_REPLICATIONS=2
export SKYCLAW_DB_PATH=.skyclaw/node-a.db
node dist/cli.js coordinator
```

2. Start coordinator B:

```bash
export SKYCLAW_TOKEN=change-me
export SKYCLAW_COORDINATOR_NODE_ID=node-b
export SKYCLAW_COORDINATOR_PORT=8788
export SKYCLAW_COORDINATOR_PUBLIC_URL=http://127.0.0.1:8788
export SKYCLAW_PEER_URLS=http://127.0.0.1:8787
export SKYCLAW_MIN_REPLICATIONS=2
export SKYCLAW_DB_PATH=.skyclaw/node-b.db
node dist/cli.js coordinator
```

3. Start a host node (any OpenClaw machine):

```bash
export SKYCLAW_TOKEN=change-me
export SKYCLAW_COORDINATOR_URLS=http://127.0.0.1:8787,http://127.0.0.1:8788
export SKYCLAW_CAPABILITIES=shell,openclaw
export SKYCLAW_ALLOWED_COMMANDS=openclaw,node,bash,sh
export SKYCLAW_OPENCLAW_COMMAND=openclaw
node dist/cli.js host
```

4. Enqueue OpenClaw work:

```bash
node dist/cli.js enqueue-openclaw run
node dist/cli.js enqueue-shell bash -lc "echo hello from decentralized skyclaw"
```

5. Deploy a TypeScript API service to the network:

```bash
# Example: run compiled TS API with Node
node dist/cli.js deploy-service my-ts-api node dist/server.js

# inspect service assignments/endpoints
node dist/cli.js list-services
```

6. Start one or more federated gateways:

```bash
export SKYCLAW_COORDINATOR_URLS=http://127.0.0.1:8787,http://127.0.0.1:8788
export SKYCLAW_GATEWAY_PORT=8790
node dist/cli.js gateway
```

Call service through gateway:

```bash
curl http://127.0.0.1:8790/v1/gateway/my-ts-api/health
```

## API

- `POST /v1/hosts/register`
- `POST /v1/hosts/:id/heartbeat`
- `POST /v1/hosts/:id/claim`
- `POST /v1/jobs`
- `POST /v1/jobs/:id/complete`
- `POST /v1/replicate/snapshot`
- `GET /v1/network/peers`
- `POST /v1/network/join`
- `POST /v1/services`
- `GET /v1/services`
- `GET /v1/services/:id`
- `POST /v1/hosts/:id/services/claim`
- `POST /v1/services/:id/report`
- `ANY /v1/gateway/:serviceName/*` (gateway process)
- `POST /v1/public/jobs`
- `GET /v1/public/jobs/:id`
- `GET /v1/state`
- `GET /health`

## Key Env Vars

- `SKYCLAW_COORDINATOR_URL`, `SKYCLAW_COORDINATOR_URLS`
- `SKYCLAW_PEER_URLS`
- `SKYCLAW_COORDINATOR_PUBLIC_URL`
- `SKYCLAW_COORDINATOR_NODE_ID`
- `SKYCLAW_MIN_REPLICATIONS` (default `2`)
- `SKYCLAW_PEER_DISCOVERY` (default `1`)
- `SKYCLAW_DB_PATH`
- `SKYCLAW_TOKEN`
- `SKYCLAW_PUBLIC_API_KEYS`
- `SKYCLAW_PUBLIC_CORS_ORIGIN`
- `SKYCLAW_CAPABILITIES`
- `SKYCLAW_ALLOWED_COMMANDS`
- `SKYCLAW_OPENCLAW_COMMAND`
- `SKYCLAW_SERVICE_HOST_ENABLED`
- `SKYCLAW_SERVICE_BASE_PORT`
- `SKYCLAW_SERVICE_HOST_PUBLIC_BASE_URL`
- `SKYCLAW_GATEWAY_HOST`
- `SKYCLAW_GATEWAY_PORT`
- `SKYCLAW_GATEWAY_REFRESH_MS`
- `SKYCLAW_GATEWAY_HEALTH_PROBE_MS`
- `SKYCLAW_GATEWAY_HEALTH_PATH`
- `SKYCLAW_GATEWAY_HEALTH_TIMEOUT_MS`
- `SKYCLAW_GATEWAY_RETRY_ATTEMPTS`
- `SKYCLAW_GATEWAY_UNHEALTHY_COOLDOWN_MS`

## Security Notes (MVP)

- Shared token auth using `x-skyclaw-token`.
- Host-side command allowlist for all executed commands.
- Timeout and output truncation safeguards.

## Status

This is an MVP decentralized coordinator/worker layer for OpenClaw.

## Dynamic P2P Opt-In

- Start with one or more bootstrap peers in `SKYCLAW_PEER_URLS`.
- Set a reachable `SKYCLAW_COORDINATOR_PUBLIC_URL` on each coordinator.
- Coordinators gossip known peers and auto-announce themselves with `/v1/network/join`.
- As nodes discover each other, the replication peer set expands automatically.

## Website API with Auth

You can expose a website-facing API on your coordinator using scoped API keys.

1. Configure public API keys and CORS:

```bash
export SKYCLAW_PUBLIC_API_KEYS="site-key-prod:site:openclaw,admin-key:admin:openclaw|shell:shell"
export SKYCLAW_PUBLIC_CORS_ORIGIN=https://your-site.com
```

Format for `SKYCLAW_PUBLIC_API_KEYS` entries:

- `<key>:<label>:<cap1|cap2>[:shell]`
- `:shell` is optional; include it only if that key may submit `shell` jobs.
- If omitted, capabilities default to `openclaw`.

2. Submit jobs from your website backend or frontend:

```bash
curl -X POST http://127.0.0.1:8787/v1/public/jobs \
  -H "Authorization: Bearer site-key-prod" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": { "kind": "openclaw-run", "args": ["run"] },
    "requirement": { "requiredCapabilities": ["openclaw"] }
  }'
```

3. Poll job status:

```bash
curl http://127.0.0.1:8787/v1/public/jobs/<job-id> \
  -H "Authorization: Bearer site-key-prod"
```

Notes:

- Public routes accept `Authorization: Bearer <key>` or `x-api-key`.
- Jobs are isolated by submitter key label; one key cannot fetch another key's jobs.
- Use a reverse proxy/TLS in front of coordinators for production websites.

## Deploying a TS API on the network

To run deployable API processes on hosts, ensure host nodes include the `service-host` capability (default in this repo) and set a reachable base URL:

```bash
export SKYCLAW_SERVICE_HOST_ENABLED=1
export SKYCLAW_SERVICE_BASE_PORT=3100
export SKYCLAW_SERVICE_HOST_PUBLIC_BASE_URL=https://node-a.example.com
```

Then deploy:

```bash
node dist/cli.js deploy-service my-ts-api node dist/server.js
```

The service host claims the deployment, starts the process, and reports endpoint metadata back to the coordinator. Frontends can call those endpoints directly (recommended via your own API gateway/domain).

## Federated Gateways

- Run multiple `skyclaw gateway` instances by different operators.
- Point each gateway to the same coordinator cluster via `SKYCLAW_COORDINATOR_URLS`.
- Put DNS or anycast in front of gateways for global entry.
- Gateway does round-robin across running service assignments discovered from coordinators.
- Gateway actively probes service health endpoints and temporarily ejects unhealthy backends.
- Gateway retries idempotent requests (`GET/HEAD/OPTIONS`) on alternate backends when upstream fails.
- If one gateway goes down, clients can fail over to another gateway endpoint.
