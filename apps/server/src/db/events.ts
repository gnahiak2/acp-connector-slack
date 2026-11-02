import type { NewSessionEvent, PublicEvent } from "@slackboard/shared";
import { asJson, asNumber, asOptionalString, asString, type Database } from "./database.js";

const map = (row: Record<string, unknown>): PublicEvent => {
  const payload = asJson<Record<string, unknown>>(row.payload, {});
  return {
    id: asNumber(row.id),
    sessionId: asString(row.session_id),
    jobId: asOptionalString(row.job_id),
    seq: asNumber(row.seq),
    type: asString(row.type),
    payload,
    createdAt: asString(row.created_at),
  } as PublicEvent;
};

export class EventRepository {
  constructor(private readonly db: Database) {}

  append(event: NewSessionEvent, now: string): PublicEvent {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?")
        .get(event.sessionId);
      const seq = asNumber(row?.next);
      const result = this.db
        .prepare(
          "INSERT INTO events (session_id, job_id, seq, type, payload, created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          event.sessionId,
          event.jobId ?? null,
          seq,
          event.type,
          JSON.stringify(event.payload),
          now,
        );
      return {
        ...event,
        id: Number(result.lastInsertRowid),
        seq,
        createdAt: now,
      } as PublicEvent;
    });
  }

  after(sessionId: string, afterSeq: number, limit = 500): PublicEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(sessionId, afterSeq, limit)
      .map((row) => map(row as Record<string, unknown>));
  }

  latest(sessionId: string, limit = 50): PublicEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?")
      .all(sessionId, limit);
    return rows.map((row) => map(row as Record<string, unknown>)).reverse();
  }

  forJob(jobId: string): PublicEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE job_id = ? ORDER BY seq")
      .all(jobId)
      .map((row) => map(row as Record<string, unknown>));
  }

  maxSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?")
      .get(sessionId);
    return asNumber(row?.seq);
  }
}
