import { describe, expect, it } from "vitest";
import { GatewayRegistry } from "../src/gateway/registry.js";
import type { ServiceRecord } from "../src/types.js";

function makeService(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id: "svc_1",
    name: "api",
    command: "node",
    args: ["dist/server.js"],
    replicas: 2,
    requiredCapabilities: ["service-host"],
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "node-a",
    version: 1,
    assignments: [
      {
        hostId: "host-a",
        status: "running",
        endpoint: "https://a.example.com",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        hostId: "host-b",
        status: "running",
        endpoint: "https://b.example.com",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    ...overrides
  };
}

describe("GatewayRegistry", () => {
  it("returns endpoints in round-robin order", () => {
    const registry = new GatewayRegistry();
    registry.updateFromServices([makeService()]);

    const first = registry.nextEndpoint("api");
    const second = registry.nextEndpoint("api");
    const third = registry.nextEndpoint("api");

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect(third).toBe(first);
  });

  it("drops keys when service has no running endpoints", () => {
    const registry = new GatewayRegistry();
    registry.updateFromServices([makeService()]);
    expect(registry.nextEndpoint("api")).toBeDefined();

    registry.updateFromServices([
      makeService({
        assignments: [
          {
            hostId: "host-a",
            status: "failed",
            endpoint: "https://a.example.com",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ],
        status: "failed"
      })
    ]);

    expect(registry.nextEndpoint("api")).toBeUndefined();
  });
});
