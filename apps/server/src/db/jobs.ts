import type { JobRecord, JobStatus } from "@slackboard/shared";
import { asOptionalString, asString, type Database } from "./database.js";

const map = (row: Record<string, unknown>): JobRecord => ({
  id: asString(row.id),
  sessionId: asString(row.session_id),
  prompt: asString(row.prompt),
  requestedBy: asString(row.requested_by),
  status: asString(row.status) as JobStatus,
  dedupeKey: asOptionalString(row.dedupe_key),
  createdAt: asString(row.created_at),
  startedAt: asOptionalString(row.started_at),
  finishedAt: asOptionalString(row.finished_at),
  stopReason: asOptionalString(row.stop_reason),
  error: asOptionalString(row.error),
});

export class JobRepository {
  constructor(private readonly db: Database) {}

  enqueue(
    input: {
      id: string;
      sessionId: string;
      prompt: string;
      requestedBy: string;
      dedupeKey?: string;
    },
    now: string,
  ): JobRecord {
    this.db
      .prepare(
        `INSERT INTO jobs (id,session_id,prompt,requested_by,status,dedupe_key,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.prompt,
        input.requestedBy,
        "queued",
        input.dedupeKey ?? null,
        now,
      );
    return this.byId(input.id)!;
  }

  byId(id: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  byDedupeKey(key: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE dedupe_key = ?").get(key);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  forSession(sessionId: string): JobRecord[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at DESC")
      .all(sessionId)
      .map((row) => map(row as Record<string, unknown>));
  }

  queued(limit = 100): JobRecord[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT ?")
      .all(limit)
      .map((row) => map(row as Record<string, unknown>));
  }

  nextQueuedForSession(sessionId: string): JobRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM jobs WHERE session_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1",
      )
      .get(sessionId);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  runningForSession(sessionId: string): JobRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM jobs WHERE session_id = ? AND status IN ('running','awaiting_approval') ORDER BY created_at LIMIT 1",
      )
      .get(sessionId);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  markStarted(id: string, now: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .run(now, id);
  }

  markAwaitingApproval(id: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'awaiting_approval' WHERE id = ? AND status = 'running'")
      .run(id);
  }

  markRunning(id: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'running' WHERE id = ? AND status = 'awaiting_approval'")
      .run(id);
  }

  markFinished(
    id: string,
    status: "completed" | "cancelled" | "failed" | "interrupted",
    now: string,
    detail: { stopReason?: string; error?: string } = {},
  ): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = ?, finished_at = ?, stop_reason = ?, error = ? WHERE id = ?",
      )
      .run(status, now, detail.stopReason ?? null, detail.error ?? null, id);
  }

  markInFlightInterrupted(now: string): JobRecord[] {
    const ids = this.db
      .prepare("SELECT id FROM jobs WHERE status IN ('running','awaiting_approval')")
      .all()
      .map((row) => asString(row.id));
    const update = this.db.prepare(
      "UPDATE jobs SET status = 'interrupted', finished_at = ?, error = ? WHERE id = ?",
    );
    this.db.transaction(() => {
      for (const id of ids) update.run(now, "Interrupted by server restart", id);
    });
    return ids.map((id) => this.byId(id)).filter((item): item is JobRecord => Boolean(item));
  }
}
