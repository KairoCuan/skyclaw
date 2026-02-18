# Skyclaw

Skyclaw is a decentralized server network for OpenClaw that anyone can run.

It is heavily inspired by `automaton-skyclaw`, but re-targeted so OpenClaw users can join a shared compute network with their own nodes.

## What it does

- Runs coordinator nodes that replicate shared state across peers.
- Lets anyone run a host daemon and contribute OpenClaw execution capacity.
- Schedules jobs to hosts with matching capabilities.
- Persists queue state in SQLite with crash recovery.
- Supports idempotent writes and multi-coordinator client failover.

## Architecture

- Coordinator cluster: job queue, host registry, leasing, replication.
- Host daemon: registers itself, heartbeats, claims jobs, executes OpenClaw work.
- Client CLI: enqueues shell/OpenClaw jobs and can target multiple coordinators.

## Install

```bash
npm install
npm run build
```

## Quick Start

1. Start coordinator A:

```bash
export SKYCLAW_TOKEN=change-me
export SKYCLAW_COORDINATOR_NODE_ID=node-a
export SKYCLAW_COORDINATOR_PORT=8787
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

## API

- `POST /v1/hosts/register`
- `POST /v1/hosts/:id/heartbeat`
- `POST /v1/hosts/:id/claim`
- `POST /v1/jobs`
- `POST /v1/jobs/:id/complete`
- `POST /v1/replicate/snapshot`
- `GET /v1/state`
- `GET /health`

## Key Env Vars

- `SKYCLAW_COORDINATOR_URL`, `SKYCLAW_COORDINATOR_URLS`
- `SKYCLAW_PEER_URLS`
- `SKYCLAW_COORDINATOR_NODE_ID`
- `SKYCLAW_MIN_REPLICATIONS` (default `2`)
- `SKYCLAW_DB_PATH`
- `SKYCLAW_TOKEN`
- `SKYCLAW_CAPABILITIES`
- `SKYCLAW_ALLOWED_COMMANDS`
- `SKYCLAW_OPENCLAW_COMMAND`

## Security Notes (MVP)

- Shared token auth using `x-skyclaw-token`.
- Host-side command allowlist for all executed commands.
- Timeout and output truncation safeguards.

## Status

This is an MVP decentralized coordinator/worker layer for OpenClaw.
