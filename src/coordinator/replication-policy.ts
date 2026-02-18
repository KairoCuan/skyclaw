export function normalizeMinReplicas(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : 2;
  return Math.max(1, n);
}

export function requiredPeerReplications(minReplicas: number): number {
  return Math.max(0, normalizeMinReplicas(minReplicas) - 1);
}

export function assertPeerCapacity(minReplicas: number, peerCount: number): void {
  const requiredPeers = requiredPeerReplications(minReplicas);
  if (peerCount < requiredPeers) {
    throw new Error(
      `insufficient peers: min replicas ${normalizeMinReplicas(minReplicas)} requires at least ${requiredPeers} peers, got ${peerCount}`
    );
  }
}
