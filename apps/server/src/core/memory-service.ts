import type { MemoryRecord } from "@slackboard/shared";
import { newId, redactText, truncateUtf8 } from "@slackboard/shared";
import type { Repositories } from "../db/index.js";
import type { AuditService } from "./audit.js";

export class MemoryValidationError extends Error {}
export class MemoryNotFoundError extends Error {}

export class MemoryService {
  constructor(
    private readonly repos: Repositories,
    private readonly audit: AuditService,
    private readonly redactValues: string[],
  ) {}

  list(projectId: string): MemoryRecord[] {
    return this.repos.memory.list(projectId);
  }

  create(input: {
    projectId: string;
    sessionId?: string;
    content: string;
    provenance: string;
    actor: string;
    proposal: boolean;
  }): MemoryRecord {
    if (!this.repos.projects.byId(input.projectId)) {
      throw new MemoryValidationError("Project not found");
    }
    const content = this.clean(input.content);
    const memory = this.repos.memory.create(
      {
        id: newId("mem"),
        projectId: input.projectId,
        sessionId: input.sessionId,
        content,
        provenance: input.provenance.slice(0, 300),
        status: input.proposal ? "proposed" : "active",
        createdBy: input.actor,
      },
      new Date().toISOString(),
    );
    this.audit.record({
      actor: input.actor,
      action: input.proposal ? "memory.proposed" : "memory.saved",
      targetType: "memory",
      targetId: memory.id,
      detail: { projectId: input.projectId, sessionId: input.sessionId },
    });
    return memory;
  }

  update(id: string, content: string, actor: string): MemoryRecord {
    const memory = this.repos.memory.byId(id);
    if (!memory || memory.status === "deleted") throw new MemoryNotFoundError("Memory not found");
    const updated = this.repos.memory.updateContent(
      id,
      this.clean(content),
      new Date().toISOString(),
    )!;
    this.audit.record({
      actor,
      action: "memory.edited",
      targetType: "memory",
      targetId: id,
      detail: { projectId: memory.projectId },
    });
    return updated;
  }

  approve(id: string, actor: string): MemoryRecord {
    const memory = this.repos.memory.byId(id);
    if (!memory) throw new MemoryNotFoundError("Memory not found");
    if (memory.status !== "proposed") throw new MemoryValidationError("Memory is not a proposal");
    const updated = this.repos.memory.setStatus(id, "active", new Date().toISOString())!;
    this.audit.record({
      actor,
      action: "memory.approved",
      targetType: "memory",
      targetId: id,
      detail: { projectId: memory.projectId },
    });
    return updated;
  }

  remove(id: string, actor: string): void {
    const memory = this.repos.memory.byId(id);
    if (!memory || memory.status === "deleted") throw new MemoryNotFoundError("Memory not found");
    this.repos.memory.setStatus(id, "deleted", new Date().toISOString());
    this.audit.record({
      actor,
      action: "memory.deleted",
      targetType: "memory",
      targetId: id,
      detail: { projectId: memory.projectId },
    });
  }

  purgeExpired(retentionDays: number | undefined): number {
    if (!retentionDays) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    return this.repos.memory.purgeDeletedBefore(cutoff);
  }

  private clean(content: string): string {
    const trimmed = content.trim();
    if (trimmed.length === 0) throw new MemoryValidationError("Memory content is empty");
    if (Buffer.byteLength(trimmed, "utf8") > 32_768) {
      throw new MemoryValidationError("Memory content is too large");
    }
    return redactText(truncateUtf8(trimmed, 32_768).text, this.redactValues);
  }
}
