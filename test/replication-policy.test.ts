import { describe, expect, it } from "vitest";
import {
  assertPeerCapacity,
  normalizeMinReplicas,
  requiredPeerReplications
} from "../src/coordinator/replication-policy.js";

describe("replication policy", () => {
  it("defaults to 2 replicas when unset", () => {
    expect(normalizeMinReplicas(undefined)).toBe(2);
  });

  it("requires minReplicas - 1 peer acknowledgements", () => {
    expect(requiredPeerReplications(3)).toBe(2);
    expect(requiredPeerReplications(1)).toBe(0);
  });

  it("rejects insufficient peer capacity", () => {
    expect(() => assertPeerCapacity(3, 1)).toThrow(/requires at least 2 peers/);
    expect(() => assertPeerCapacity(3, 2)).not.toThrow();
  });
});
