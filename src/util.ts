import { randomUUID } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function normalizeCapabilities(caps: string[] | undefined): string[] {
  if (!caps?.length) return [];
  return [...new Set(caps.map((c) => c.trim()).filter(Boolean))].sort();
}

export function hasCapabilities(hostCapabilities: string[], required: string[] | undefined): boolean {
  if (!required?.length) return true;
  const set = new Set(hostCapabilities);
  return required.every((cap) => set.has(cap));
}

export function parseIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
