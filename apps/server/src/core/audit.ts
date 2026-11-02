import { newId, redactObject } from "@slackboard/shared";
import type { AuditRepository } from "../db/audit.js";

export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly redactValues: string[],
  ) {}

  record(input: {
    actor: string;
    action: string;
    targetType: string;
    targetId?: string;
    detail?: Record<string, unknown>;
  }): void {
    this.repository.append(
      {
        id: newId("audit"),
        actor: input.actor,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        detail: redactObject(input.detail ?? {}, this.redactValues),
      },
      new Date().toISOString(),
    );
  }
}
