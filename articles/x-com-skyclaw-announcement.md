# Skyclaw: A Decentralized Server Network for OpenClaw

OpenClaw is powerful, but most setups still depend on a single machine.
Skyclaw changes that.

Skyclaw is a decentralized coordinator + worker network for OpenClaw that anyone can run.
Think: shared, opt-in infrastructure where independent nodes can join, execute jobs, deploy services, and replicate state across peers.

Package: `@razroo/skyclaw`

## What Skyclaw is

- A coordinator cluster that tracks hosts, jobs, and services.
- A host daemon that runs on OpenClaw machines and executes work.
- A service runtime that can run deployable TypeScript APIs on participating hosts.
- A federated gateway layer for global routing across running service endpoints.

## Why this matters

- No single server bottleneck.
- Anyone can contribute capacity.
- Better resilience through replicated coordinator state.
- Open execution model with host-side safety controls.
- Real path from "my frontend" to "decentralized backend compute/services".

## How it works

1. Coordinators join from bootstrap peers.
2. Coordinators discover and gossip peers automatically (`/v1/network/peers`, `/v1/network/join`).
3. OpenClaw hosts register and heartbeat.
4. Jobs are enqueued (`shell` or `openclaw-run`).
5. Services can be deployed (for example: TypeScript API process command).
6. Federated gateways route requests to healthy service endpoints.

## P2P opt-in network

- New coordinators can opt in with minimal config and bootstrap peers.
- Peer membership expands dynamically as nodes discover each other.
- The network can grow without manually wiring every node to every other node.

## Federated gateways

- Multiple operators can run `skyclaw gateway`.
- Gateways discover service endpoints from coordinators.
- Round-robin load balancing across running endpoints.
- Active health probes and retry-on-failure for idempotent requests.
- Clients can fail over across multiple gateway domains.

## Safety and reliability (MVP)

- Shared token auth (`x-skyclaw-token`) for coordinator/private routes.
- API key auth for public submission routes.
- Command allowlist on each host.
- Timeouts + output truncation.
- SQLite persistence and crash recovery.
- Idempotency keys for safe retries.

## Current status

Skyclaw is an MVP, but it already supports:

- Multi-node coordinator replication
- Dynamic peer discovery and coordinator self-announcement
- Deployable service runtime on host nodes
- Federated gateway routing and health-aware failover
- OpenClaw-specific job scheduling

If you can run OpenClaw, you can run a Skyclaw node.
