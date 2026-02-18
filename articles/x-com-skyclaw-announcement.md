# Skyclaw: A Decentralized Server Network for OpenClaw

OpenClaw is powerful, but most setups still depend on a single machine.
Skyclaw changes that.

Skyclaw is a decentralized coordinator + worker network for OpenClaw that anyone can run.
Think: shared, opt-in infrastructure where independent nodes can join, execute jobs, and replicate state across peers.

## What Skyclaw is

- A coordinator cluster that tracks hosts and jobs.
- A host daemon that runs on OpenClaw machines and executes work.
- A lightweight CLI for enqueueing jobs.

## Why this matters

- No single server bottleneck.
- Anyone can contribute capacity.
- Better resilience through replicated coordinator state.
- Open execution model with host-side safety controls.

## How it works

1. Coordinators join from bootstrap peers.
2. Coordinators discover and gossip peers automatically (`/v1/network/peers`, `/v1/network/join`).
3. OpenClaw hosts register and heartbeat.
4. Jobs are enqueued (`shell` or `openclaw-run`).
5. Eligible hosts claim and execute jobs.
6. Results are posted back to the cluster.

## P2P opt-in network

- New coordinators can opt in with minimal config and bootstrap peers.
- Peer membership expands dynamically as nodes discover each other.
- The network can grow without manually wiring every node to every other node.

## Safety and reliability (MVP)

- Shared token auth (`x-skyclaw-token`).
- Command allowlist on each host.
- Timeouts + output truncation.
- SQLite persistence and crash recovery.
- Idempotency keys for safe retries.

## Who this is for

- OpenClaw operators who want distributed execution.
- Builders who want a public, opt-in compute layer.
- Teams experimenting with decentralized AI infrastructure.

## Current status

Skyclaw is an MVP, but it already supports:

- Multi-node coordinator replication
- Dynamic peer discovery and coordinator self-announcement
- Host failover across coordinator URLs
- Durable queue state
- OpenClaw-specific job scheduling

If you can run OpenClaw, you can run a Skyclaw node.
