import type {
  ApprovalKind,
  ApprovalOption,
  ApprovalRecord,
  ApprovalStatus,
  PendingApprovalView,
} from "@slackboard/shared";
import { asJson, asOptionalString, asString, type Database } from "./database.js";

const map = (row: Record<string, unknown>): ApprovalRecord => ({
  id: asString(row.id),
  sessionId: asString(row.session_id),
  jobId: asOptionalString(row.job_id),
  kind: asString(row.kind) as ApprovalKind,
  toolCallId: asOptionalString(row.tool_call_id),
  title: asString(row.title),
  details: asJson<Record<string, unknown>>(row.details, {}),
  options: asJson<ApprovalOption[]>(row.options, []),
  status: asString(row.status) as ApprovalStatus,
  requestedBy: asOptionalString(row.requested_by),
  resolvedBy: asOptionalString(row.resolved_by),
  optionId: asOptionalString(row.option_id),
  resolution: asOptionalString(row.resolution),
  expiresAt: asString(row.expires_at),
  createdAt: asString(row.created_at),
  resolvedAt: asOptionalString(row.resolved_at),
});

export interface CreateApprovalInput {
  id: string;
  sessionId: string;
  jobId?: string;
  kind: ApprovalKind;
  toolCallId?: string;
  title: string;
  details?: Record<string, unknown>;
  options: ApprovalOption[];
  requestedBy?: string;
  expiresAt: string;
}

export class ApprovalRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateApprovalInput, now: string): ApprovalRecord {
    this.db
      .prepare(
        `INSERT INTO approvals (id,session_id,job_id,kind,tool_call_id,title,details,options,status,requested_by,expires_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.jobId ?? null,
        input.kind,
        input.toolCallId ?? null,
        input.title,
        JSON.stringify(input.details ?? {}),
        JSON.stringify(input.options),
        "pending",
        input.requestedBy ?? null,
        input.expiresAt,
        now,
      );
    return this.byId(input.id)!;
  }

  byId(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  pendingForSession(sessionId: string): ApprovalRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at",
      )
      .all(sessionId)
      .map((row) => map(row as Record<string, unknown>));
  }

  pendingByToolCall(sessionId: string, toolCallId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM approvals WHERE session_id = ? AND tool_call_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId, toolCallId);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  listPending(): PendingApprovalView[] {
    return this.db
      .prepare(
        `SELECT ap.*, s.title AS session_title
         FROM approvals ap JOIN sessions s ON s.id = ap.session_id
         WHERE ap.status = 'pending' AND ap.expires_at > ?
         ORDER BY ap.created_at ASC`,
      )
      .all(new Date().toISOString())
      .map((row) => ({
        ...map(row as Record<string, unknown>),
        sessionTitle: asString(row.session_title),
      }));
  }

  resolve(
    id: string,
    input: { optionId?: string; resolution: string; resolvedBy: string },
    now: string,
  ): { resolved: boolean; approval?: ApprovalRecord } {
    const result = this.db
      .prepare(
        `UPDATE approvals
         SET status = 'resolved', resolved_by = ?, option_id = ?, resolution = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .run(input.resolvedBy, input.optionId ?? null, input.resolution, now, id, now);
    if (Number(result.changes) !== 1) {
      return { resolved: false, approval: this.byId(id) };
    }
    return { resolved: true, approval: this.byId(id) };
  }

  expireStale(now: string): ApprovalRecord[] {
    const ids = this.db
      .prepare("SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ?")
      .all(now)
      .map((row) => asString(row.id));
    if (ids.length === 0) return [];
    const update = this.db.prepare(
      "UPDATE approvals SET status = 'expired', resolution = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
    );
    this.db.transaction(() => {
      for (const id of ids) update.run(now, id);
    });
    return ids.map((id) => this.byId(id)).filter((item): item is ApprovalRecord => Boolean(item));
  }

  expireOne(id: string, now: string): ApprovalRecord | undefined {
    const result = this.db
      .prepare(
        "UPDATE approvals SET status = 'expired', resolution = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, id);
    return Number(result.changes) === 1 ? this.byId(id) : undefined;
  }

  cancelPendingForSession(sessionId: string, now: string, reason: string): ApprovalRecord[] {
    const ids = this.db
      .prepare("SELECT id FROM approvals WHERE session_id = ? AND status = 'pending'")
      .all(sessionId)
      .map((row) => asString(row.id));
    if (ids.length === 0) return [];
    const update = this.db.prepare(
      "UPDATE approvals SET status = 'cancelled', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
    );
    this.db.transaction(() => {
      for (const id of ids) update.run(reason, now, id);
    });
    return ids.map((id) => this.byId(id)).filter((item): item is ApprovalRecord => Boolean(item));
  }
}
