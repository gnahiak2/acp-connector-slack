import type { AuditRecord } from "@slackboard/shared";
import { asJson, asOptionalString, asString, type Database } from "./database.js";

export class AuditRepository {
  constructor(private readonly db: Database) {}

  append(
    input: {
      id: string;
      actor: string;
      action: string;
      targetType: string;
      targetId?: string;
      detail?: Record<string, unknown>;
    },
    now: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_log (id,actor,action,target_type,target_id,detail,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.actor,
        input.action,
        input.targetType,
        input.targetId ?? null,
        JSON.stringify(input.detail ?? {}),
        now,
      );
  }

  list(limit = 100, offset = 0): AuditRecord[] {
    return this.db
      .prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(Math.min(limit, 500), Math.max(offset, 0))
      .map((row) => ({
        id: asString(row.id),
        actor: asString(row.actor),
        action: asString(row.action),
        targetType: asString(row.target_type),
        targetId: asOptionalString(row.target_id),
        detail: asJson<Record<string, unknown>>(row.detail, {}),
        createdAt: asString(row.created_at),
      }));
  }
}
