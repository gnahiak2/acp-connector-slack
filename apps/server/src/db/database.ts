import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { migrations } from "./migrations.js";

export type SqlValue = null | number | bigint | string | Uint8Array;

export class Database {
  readonly raw: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA busy_timeout = 5000");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      this.raw
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((row) => Number(row.version)),
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.raw.exec(migration.sql);
        this.raw
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, new Date().toISOString());
      });
    }
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    }
  }

  close(): void {
    try {
      this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Best effort checkpoint.
    }
    this.raw.close();
  }
}

export const asString = (value: unknown): string => String(value ?? "");
export const asOptionalString = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);
export const asNumber = (value: unknown): number => Number(value ?? 0);
export const asBoolean = (value: unknown): boolean => Number(value ?? 0) === 1;
export const asJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
