import type { ServiceRecord } from "../types.js";

interface ServiceTargetState {
  endpoints: string[];
  index: number;
  refreshedAt: number;
}

interface EndpointHealthState {
  unhealthyUntil: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

export interface GatewayRegistryOptions {
  unhealthyCooldownMs?: number;
}

export class GatewayRegistry {
  private readonly states = new Map<string, ServiceTargetState>();
  private readonly endpointHealth = new Map<string, EndpointHealthState>();
  private readonly unhealthyCooldownMs: number;

  constructor(options: GatewayRegistryOptions = {}) {
    this.unhealthyCooldownMs = Math.max(1_000, options.unhealthyCooldownMs ?? 10_000);
  }

  updateFromServices(services: ServiceRecord[]): void {
    const next = new Map<string, string[]>();

    for (const service of services) {
      const endpoints = service.assignments
        .filter((assignment) => assignment.status === "running" && Boolean(assignment.endpoint))
        .map((assignment) => assignment.endpoint!.replace(/\/$/, ""));

      if (endpoints.length === 0) {
        continue;
      }

      const uniqueEndpoints = [...new Set(endpoints)].sort();
      next.set(service.id, uniqueEndpoints);
      next.set(service.name, uniqueEndpoints);
    }

    const now = Date.now();
    for (const [key, endpoints] of next.entries()) {
      const prev = this.states.get(key);
      this.states.set(key, {
        endpoints,
        index: prev ? prev.index % endpoints.length : 0,
        refreshedAt: now
      });
    }

    for (const key of [...this.states.keys()]) {
      if (!next.has(key)) {
        this.states.delete(key);
      }
    }

    const knownEndpoints = new Set<string>();
    for (const state of this.states.values()) {
      for (const endpoint of state.endpoints) {
        knownEndpoints.add(endpoint);
      }
    }
    for (const endpoint of [...this.endpointHealth.keys()]) {
      if (!knownEndpoints.has(endpoint)) {
        this.endpointHealth.delete(endpoint);
      }
    }
  }

  nextEndpoint(serviceKey: string): string | undefined {
    return this.nextEndpoints(serviceKey, 1)[0];
  }

  nextEndpoints(serviceKey: string, maxAttempts: number): string[] {
    const state = this.states.get(serviceKey);
    if (!state || state.endpoints.length === 0 || maxAttempts <= 0) {
      return [];
    }

    const healthy = state.endpoints.filter((endpoint) => this.isEndpointHealthy(endpoint));
    const candidates = healthy.length > 0 ? healthy : state.endpoints;
    if (candidates.length === 0) {
      return [];
    }

    const start = state.index % candidates.length;
    const ordered = rotate(candidates, start);
    state.index = (state.index + 1) % candidates.length;

    return ordered.slice(0, Math.min(maxAttempts, ordered.length));
  }

  markEndpointFailure(endpoint: string): void {
    const now = Date.now();
    const prev = this.endpointHealth.get(endpoint);
    this.endpointHealth.set(endpoint, {
      unhealthyUntil: now + this.unhealthyCooldownMs,
      lastFailureAt: now,
      lastSuccessAt: prev?.lastSuccessAt
    });
  }

  markEndpointSuccess(endpoint: string): void {
    const now = Date.now();
    const prev = this.endpointHealth.get(endpoint);
    this.endpointHealth.set(endpoint, {
      unhealthyUntil: 0,
      lastFailureAt: prev?.lastFailureAt,
      lastSuccessAt: now
    });
  }

  isEndpointHealthy(endpoint: string): boolean {
    const state = this.endpointHealth.get(endpoint);
    if (!state) return true;
    return state.unhealthyUntil <= Date.now();
  }

  listServiceKeys(): string[] {
    return [...this.states.keys()].sort();
  }

  listAllEndpoints(): string[] {
    const out = new Set<string>();
    for (const state of this.states.values()) {
      for (const endpoint of state.endpoints) {
        out.add(endpoint);
      }
    }
    return [...out.values()].sort();
  }
}

function rotate<T>(input: T[], start: number): T[] {
  if (input.length === 0) return [];
  const idx = ((start % input.length) + input.length) % input.length;
  return input.slice(idx).concat(input.slice(0, idx));
}
