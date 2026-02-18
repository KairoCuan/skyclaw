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

1. Coordinators form a peer cluster.
2. OpenClaw hosts register and heartbeat.
3. Jobs are enqueued (`shell` or `openclaw-run`).
4. Eligible hosts claim and execute jobs.
5. Results are posted back to the cluster.

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
- Host failover across coordinator URLs
- Durable queue state
- OpenClaw-specific job scheduling

If you can run OpenClaw, you can run a Skyclaw node.
