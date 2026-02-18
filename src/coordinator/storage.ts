import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HostRecord, JobRecord } from "../types.js";

export interface StoredIdempotencyRecord {
  route: string;
  key: string;
  requestHash: string;
  statusCode: number;
  responseJson: string;
  createdAt: string;
  expiresAt: string;
}

export class CoordinatorStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new DatabaseSync(resolved);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);

      CREATE TABLE IF NOT EXISTS idempotency (
        route TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (route, key)
      );

      CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency(expires_at);
    `);
  }

  loadHosts(): HostRecord[] {
    const rows = this.db.prepare("SELECT json FROM hosts").all() as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as HostRecord);
  }

  loadJobs(): JobRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM jobs ORDER BY created_at ASC")
      .all() as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as JobRecord);
  }

  saveHost(host: HostRecord): void {
    this.db
      .prepare(`INSERT INTO hosts (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json`)
      .run(host.id, JSON.stringify(host));
  }

  saveJob(job: JobRecord): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, created_at, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, json=excluded.json`
      )
      .run(job.id, job.createdAt, JSON.stringify(job));
  }

  replaceAll(hosts: HostRecord[], jobs: JobRecord[]): void {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.exec("DELETE FROM hosts;");
      this.db.exec("DELETE FROM jobs;");

      const insertHost = this.db.prepare("INSERT INTO hosts (id, json) VALUES (?, ?)");
      for (const host of hosts) {
        insertHost.run(host.id, JSON.stringify(host));
      }

      const insertJob = this.db.prepare("INSERT INTO jobs (id, created_at, json) VALUES (?, ?, ?)");
      for (const job of jobs) {
        insertJob.run(job.id, job.createdAt, JSON.stringify(job));
      }

      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  getIdempotency(route: string, key: string): StoredIdempotencyRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT route, key, request_hash, status_code, response_json, created_at, expires_at
         FROM idempotency WHERE route = ? AND key = ?`
      )
      .get(route, key) as
      | {
          route: string;
          key: string;
          request_hash: string;
          status_code: number;
          response_json: string;
          created_at: string;
          expires_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      route: row.route,
      key: row.key,
      requestHash: row.request_hash,
      statusCode: row.status_code,
      responseJson: row.response_json,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  saveIdempotency(record: StoredIdempotencyRecord): void {
    this.db
      .prepare(
        `INSERT INTO idempotency (route, key, request_hash, status_code, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(route, key) DO UPDATE SET
           request_hash=excluded.request_hash,
           status_code=excluded.status_code,
           response_json=excluded.response_json,
           created_at=excluded.created_at,
           expires_at=excluded.expires_at`
      )
      .run(
        record.route,
        record.key,
        record.requestHash,
        record.statusCode,
        record.responseJson,
        record.createdAt,
        record.expiresAt
      );
  }

  deleteExpiredIdempotency(nowIso: string): number {
    const result = this.db
      .prepare("DELETE FROM idempotency WHERE expires_at <= ?")
      .run(nowIso) as { changes?: number };
    return result.changes ?? 0;
  }
}
