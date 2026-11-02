import type { MemoryRecord, MemoryStatus } from "@slackboard/shared";
import { asOptionalString, asString, type Database } from "./database.js";

const map = (row: Record<string, unknown>): MemoryRecord => ({
  id: asString(row.id),
  projectId: asString(row.project_id),
  sessionId: asOptionalString(row.session_id),
  content: asString(row.content),
  provenance: asString(row.provenance),
  status: asString(row.status) as MemoryStatus,
  createdBy: asString(row.created_by),
  createdAt: asString(row.created_at),
  updatedAt: asString(row.updated_at),
  deletedAt: asOptionalString(row.deleted_at),
});

export class MemoryRepository {
  constructor(private readonly db: Database) {}

  create(
    input: {
      id: string;
      projectId: string;
      sessionId?: string;
      content: string;
      provenance: string;
      status: MemoryStatus;
      createdBy: string;
    },
    now: string,
  ): MemoryRecord {
    this.db
      .prepare(
        `INSERT INTO memory (id,project_id,session_id,content,provenance,status,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.sessionId ?? null,
        input.content,
        input.provenance,
        input.status,
        input.createdBy,
        now,
        now,
      );
    return this.byId(input.id)!;
  }

  byId(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory WHERE id = ?").get(id);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  list(projectId: string, status?: MemoryStatus): MemoryRecord[] {
    const rows = status
      ? this.db
          .prepare(
            "SELECT * FROM memory WHERE project_id = ? AND status = ? ORDER BY updated_at DESC",
          )
          .all(projectId, status)
      : this.db
          .prepare("SELECT * FROM memory WHERE project_id = ? ORDER BY updated_at DESC")
          .all(projectId);
    return rows.map((row) => map(row as Record<string, unknown>));
  }

  activeForProject(projectId: string, limit = 40): MemoryRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM memory WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?",
      )
      .all(projectId, limit)
      .map((row) => map(row as Record<string, unknown>));
  }

  updateContent(id: string, content: string, now: string): MemoryRecord | undefined {
    this.db
      .prepare("UPDATE memory SET content = ?, updated_at = ? WHERE id = ? AND status != 'deleted'")
      .run(content, now, id);
    return this.byId(id);
  }

  setStatus(id: string, status: MemoryStatus, now: string): MemoryRecord | undefined {
    this.db
      .prepare(
        "UPDATE memory SET status = ?, updated_at = ?, deleted_at = ? WHERE id = ?",
      )
      .run(status, now, status === "deleted" ? now : null, id);
    return this.byId(id);
  }

  purgeDeletedBefore(cutoff: string): number {
    const result = this.db
      .prepare("DELETE FROM memory WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?")
      .run(cutoff);
    return Number(result.changes);
  }
}
