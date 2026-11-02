import type { ApprovalOption, ApprovalRecord } from "@slackboard/shared";
import { newApprovalId, truncateUtf8 } from "@slackboard/shared";
import type { ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { PermissionDecision } from "@slackboard/acp";
import type { Repositories } from "../db/index.js";
import type { EventService } from "./events.js";
import type { AccessService, Actor } from "./access.js";
import type { AuditService } from "./audit.js";

export class ApprovalNotFoundError extends Error {}
export class ApprovalConflictError extends Error {}
export class ApprovalForbiddenError extends Error {}

export interface ResolveApprovalResult {
  approval: ApprovalRecord;
  action?: Record<string, unknown>;
  error?: string;
}

interface PendingApproval {
  timer: NodeJS.Timeout;
  resolve?: (decision: PermissionDecision) => void;
}

export class ApprovalService {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly handlers = new Map<
    ApprovalRecord["kind"],
    (approval: ApprovalRecord) => Promise<Record<string, unknown>>
  >();

  constructor(
    private readonly repos: Repositories,
    private readonly events: EventService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly options: { timeoutMs: number },
  ) {}

  registerHandler(
    kind: ApprovalRecord["kind"],
    handler: (approval: ApprovalRecord) => Promise<Record<string, unknown>>,
  ): void {
    this.handlers.set(kind, handler);
  }

  async requestAcpPermission(input: {
    sessionId: string;
    jobId?: string;
    toolCall: ToolCallUpdate;
    options: ApprovalOption[];
    requestedBy?: string;
  }): Promise<PermissionDecision> {
    if (input.options.length === 0) return { outcome: "cancelled" };
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.options.timeoutMs).toISOString();
    const approvalId = newApprovalId();
    const title = (input.toolCall.title ?? "Tool call approval").slice(0, 400);
    const details = {
      toolCallId: input.toolCall.toolCallId,
      kind: input.toolCall.kind ?? undefined,
      status: input.toolCall.status ?? undefined,
      locations: (input.toolCall.locations ?? []).slice(0, 20),
      contentPreview: truncateUtf8(
        JSON.stringify(input.toolCall.content ?? input.toolCall.rawInput ?? ""),
        4_000,
      ).text,
    };
    this.repos.approvals.create(
      {
        id: approvalId,
        sessionId: input.sessionId,
        jobId: input.jobId,
        kind: "acp_permission",
        toolCallId: input.toolCall.toolCallId,
        title,
        details,
        options: input.options,
        requestedBy: input.requestedBy,
        expiresAt,
      },
      now.toISOString(),
    );
    this.events.append({
      sessionId: input.sessionId,
      jobId: input.jobId,
      type: "approval.requested",
      payload: {
        approvalId,
        title,
        toolCallId: input.toolCall.toolCallId,
        options: input.options,
        expiresAt,
      },
    });
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        void this.expire(approvalId);
      }, this.options.timeoutMs);
      timer.unref();
      this.pending.set(approvalId, { timer, resolve });
      this.audit.record({
        actor: "agent",
        action: "approval.requested",
        targetType: "approval",
        targetId: approvalId,
        detail: { sessionId: input.sessionId, toolCallId: input.toolCall.toolCallId },
      });
    });
  }

  requestGithubApproval(input: {
    sessionId: string;
    jobId?: string;
    requestedBy: string;
    details: Record<string, unknown>;
    title: string;
  }): ApprovalRecord {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.options.timeoutMs).toISOString();
    const approval = this.repos.approvals.create(
      {
        id: newApprovalId(),
        sessionId: input.sessionId,
        jobId: input.jobId,
        kind: "github_push",
        title: input.title.slice(0, 400),
        details: input.details,
        options: [
          { optionId: "approve", name: "Create draft pull request", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
        requestedBy: input.requestedBy,
        expiresAt,
      },
      now.toISOString(),
    );
    this.events.append({
      sessionId: input.sessionId,
      jobId: input.jobId,
      type: "github.approval.requested",
      payload: {
        approvalId: approval.id,
        repository: String(input.details.repository ?? ""),
        head: String(input.details.head ?? ""),
        base: String(input.details.base ?? ""),
        title: input.title,
      },
    });
    this.armTimer(approval.id);
    return approval;
  }

  listPending(): ApprovalRecord[] {
    return this.repos.approvals.listPending().map(({ sessionTitle: _sessionTitle, ...item }) => item);
  }

  async resolve(
    id: string,
    input: { optionId: string; actor: Actor },
  ): Promise<ResolveApprovalResult> {
    const approval = this.repos.approvals.byId(id);
    if (!approval) throw new ApprovalNotFoundError("Approval not found");
    if (approval.status !== "pending") {
      throw new ApprovalConflictError(`Approval is already ${approval.status}`);
    }
    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      await this.expire(id);
      throw new ApprovalConflictError("Approval has expired");
    }
    const session = this.repos.sessions.byId(approval.sessionId);
    if (!session || !this.access.sessionAllowed(session, input.actor)) {
      throw new ApprovalForbiddenError("Not authorised to resolve this approval");
    }
    if (!approval.options.some((option) => option.optionId === input.optionId)) {
      throw new ApprovalConflictError("Option is not part of this approval request");
    }
    const now = new Date().toISOString();
    const resolved = this.repos.approvals.resolve(
      id,
      {
        optionId: input.optionId,
        resolution: input.optionId,
        resolvedBy: input.actor.id,
      },
      now,
    );
    if (!resolved.resolved || !resolved.approval) {
      const current = this.repos.approvals.byId(id);
      throw new ApprovalConflictError(`Approval is already ${current?.status ?? "resolved"}`);
    }
    this.clearTimer(id);
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.resolve?.({ outcome: "selected", optionId: input.optionId });
    this.events.append({
      sessionId: approval.sessionId,
      jobId: approval.jobId,
      type: "approval.resolved",
      payload: {
        approvalId: id,
        outcome: "selected",
        optionId: input.optionId,
        resolvedBy: input.actor.id,
        resolution: input.optionId,
      },
    });
    this.audit.record({
      actor: input.actor.id,
      action: "approval.resolved",
      targetType: "approval",
      targetId: id,
      detail: { optionId: input.optionId, kind: approval.kind },
    });

    const isApproved =
      approval.kind === "github_push" ? input.optionId === "approve" : true;
    if (isApproved && approval.kind !== "acp_permission") {
      const handler = this.handlers.get(approval.kind);
      if (handler) {
        try {
          const action = await handler(resolved.approval);
          return { approval: resolved.approval, action };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.events.append({
            sessionId: approval.sessionId,
            jobId: approval.jobId,
            type: "session.error",
            payload: { message: `Approved action failed: ${message}` },
          });
          this.audit.record({
            actor: "system",
            action: "approval.action_failed",
            targetType: "approval",
            targetId: id,
            detail: { message },
          });
          return { approval: resolved.approval, error: message };
        }
      }
    }
    return { approval: resolved.approval };
  }

  async cancelForSession(sessionId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const cancelled = this.repos.approvals.cancelPendingForSession(sessionId, now, reason);
    for (const approval of cancelled) {
      this.clearTimer(approval.id);
      const pending = this.pending.get(approval.id);
      this.pending.delete(approval.id);
      pending?.resolve?.({ outcome: "cancelled" });
      this.events.append({
        sessionId,
        jobId: approval.jobId,
        type: "approval.resolved",
        payload: {
          approvalId: approval.id,
          outcome: "cancelled",
          resolution: reason,
        },
      });
    }
  }

  async expireStale(): Promise<void> {
    const expired = this.repos.approvals.expireStale(new Date().toISOString());
    for (const approval of expired) {
      this.clearTimer(approval.id);
      const pending = this.pending.get(approval.id);
      this.pending.delete(approval.id);
      pending?.resolve?.({ outcome: "cancelled" });
      this.events.append({
        sessionId: approval.sessionId,
        jobId: approval.jobId,
        type: "approval.expired",
        payload: { approvalId: approval.id },
      });
    }
  }

  async shutdown(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.repos.approvals.expireOne(id, new Date().toISOString());
      pending.resolve?.({ outcome: "cancelled" });
    }
    this.pending.clear();
  }

  private armTimer(id: string): void {
    const timer = setTimeout(() => {
      void this.expire(id);
    }, this.options.timeoutMs);
    timer.unref();
    this.pending.set(id, { timer });
  }

  private async expire(id: string): Promise<void> {
    const expired = this.repos.approvals.expireOne(id, new Date().toISOString());
    if (!expired || expired.status !== "expired") return;
    this.clearTimer(id);
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.resolve?.({ outcome: "cancelled" });
    this.events.append({
      sessionId: expired.sessionId,
      jobId: expired.jobId,
      type: "approval.expired",
      payload: { approvalId: id },
    });
    this.audit.record({
      actor: "system",
      action: "approval.expired",
      targetType: "approval",
      targetId: id,
      detail: { sessionId: expired.sessionId },
    });
  }

  private clearTimer(id: string): void {
    const pending = this.pending.get(id);
    if (pending) clearTimeout(pending.timer);
  }
}
