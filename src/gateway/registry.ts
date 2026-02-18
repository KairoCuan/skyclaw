import type { ServiceRecord } from "../types.js";

interface ServiceTargetState {
  endpoints: string[];
  index: number;
  refreshedAt: number;
}

export class GatewayRegistry {
  private readonly states = new Map<string, ServiceTargetState>();

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
  }

  nextEndpoint(serviceKey: string): string | undefined {
    const state = this.states.get(serviceKey);
    if (!state || state.endpoints.length === 0) {
      return undefined;
    }
    const endpoint = state.endpoints[state.index % state.endpoints.length];
    state.index = (state.index + 1) % state.endpoints.length;
    return endpoint;
  }

  listServiceKeys(): string[] {
    return [...this.states.keys()].sort();
  }
}
