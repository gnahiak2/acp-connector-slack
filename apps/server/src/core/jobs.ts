import type { AppConfig, JobRecord, ProjectRecord, SessionRecord, SessionStatus } from "@slackboard/shared";
import { newId, preview, truncateUtf8 } from "@slackboard/shared";
import { AcpAuthRequiredError, AcpTimeoutError } from "@slackboard/acp";
import type { Repositories } from "../db/index.js";
import type { EventService } from "./events.js";
import type { WorkspaceManager } from "./workspace.js";
import type { AgentManager } from "./agent-manager.js";
import type { ApprovalService } from "./approvals.js";
import type { AuditService } from "./audit.js";

export class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueError";
  }
}

interface ActiveRun {
  jobId: string;
  promise: Promise<void>;
}

interface EnqueueInput {
  sessionId: string;
  prompt: string;
  requestedBy: string;
  dedupeKey?: string;
}

export class JobQueue {
  private readonly queued = new Map<string, JobRecord>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly workspaceLocks = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  private readonly interruptReasons = new Map<string, string>();
  private readonly stopAfter = new Set<string>();
  private running = 0;
  private pumping = false;
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly events: EventService,
    private readonly workspace: WorkspaceManager,
    private readonly agents: AgentManager,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditService,
  ) {}

  async recover(): Promise<void> {
    const now = new Date().toISOString();
    const sessions = this.repos.sessions.markInFlightInterrupted(now);
    const jobs = this.repos.jobs.markInFlightInterrupted(now);
    for (const session of sessions) {
      this.events.append({
        sessionId: session.id,
        type: "session.status",
        payload: { status: "interrupted", previousStatus: "running" },
      });
      await this.approvals.cancelForSession(session.id, "Interrupted by server restart");
    }
    for (const job of jobs) {
      this.events.append({
        sessionId: job.sessionId,
        jobId: job.id,
        type: "job.finished",
        payload: {
          status: "interrupted",
          error: "Interrupted by server restart; the turn was not replayed automatically",
        },
      });
    }
    for (const job of this.repos.jobs.queued()) this.queued.set(job.id, job);
    if (this.queued.size > 0) this.pump();
  }

  enqueue(input: EnqueueInput): { job: JobRecord; duplicate: boolean } {
    if (this.stopped) throw new QueueError("Server is shutting down");
    const session = this.repos.sessions.byId(input.sessionId);
    if (!session) throw new QueueError("Session not found");
    if (session.archivedAt) throw new QueueError("Session is archived");
    if (input.prompt.trim().length === 0) throw new QueueError("Prompt is empty");
    if (Buffer.byteLength(input.prompt, "utf8") > this.config.limits.maxMessageBytes) {
      throw new QueueError("Prompt exceeds the configured message size limit");
    }
    if (input.dedupeKey) {
      const existing = this.repos.jobs.byDedupeKey(input.dedupeKey);
      if (existing) return { job: existing, duplicate: true };
    }
    const job = this.repos.jobs.enqueue(
      {
        id: newId("job"),
        sessionId: input.sessionId,
        prompt: input.prompt,
        requestedBy: input.requestedBy,
        dedupeKey: input.dedupeKey,
      },
      new Date().toISOString(),
    );
    this.events.append({
      sessionId: session.id,
      jobId: job.id,
      type: "job.queued",
      payload: {
        promptPreview: preview(input.prompt, 300),
        requestedBy: input.requestedBy,
      },
    });
    if (!this.active.has(session.id)) {
      this.setSessionStatus(session, "queued");
    }
    this.queued.set(job.id, job);
    this.audit.record({
      actor: input.requestedBy,
      action: "job.enqueued",
      targetType: "session",
      targetId: session.id,
      detail: { jobId: job.id },
    });
    this.pump();
    return { job, duplicate: false };
  }

  async cancel(sessionId: string, actor: string, mode: "cancel" | "stop" = "cancel"): Promise<void> {
    const reason = mode === "stop" ? "Stopped by user" : "Cancelled by user";
    for (const [jobId, job] of this.queued) {
      if (job.sessionId !== sessionId) continue;
      this.queued.delete(jobId);
      this.repos.jobs.markFinished(jobId, "cancelled", new Date().toISOString(), { error: reason });
      this.events.append({
        sessionId,
        jobId,
        type: "job.finished",
        payload: { status: "cancelled", error: reason },
      });
    }
    const active = this.active.get(sessionId);
    if (!active) {
      const session = this.repos.sessions.byId(sessionId);
      if (session) {
        this.setSessionStatus(session, mode === "stop" ? "stopped" : "cancelled");
        if (mode === "stop") await this.agents.stop(sessionId, reason);
      }
      this.audit.record({
        actor,
        action: mode,
        targetType: "session",
        targetId: sessionId,
        detail: {},
      });
      return;
    }
    this.cancelled.add(active.jobId);
    if (mode === "stop") this.stopAfter.add(sessionId);
    await this.agents.cancel(sessionId, reason);
    await Promise.race([active.promise, new Promise((resolve) => setTimeout(resolve, 8_000))]);
    if (mode === "stop") {
      this.stopAfter.delete(sessionId);
      await this.agents.stop(sessionId, reason);
    }
    this.audit.record({
      actor,
      action: mode,
      targetType: "session",
      targetId: sessionId,
      detail: { jobId: active.jobId },
    });
  }

  activeJob(sessionId: string): string | undefined {
    return this.active.get(sessionId)?.jobId;
  }

  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  notifyAgentExit(sessionId: string, reason: string): void {
    const active = this.active.get(sessionId);
    if (active) this.interruptReasons.set(active.jobId, reason);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const active = [...this.active.entries()];
    for (const [sessionId, run] of active) {
      this.cancelled.add(run.jobId);
      this.interruptReasons.set(run.jobId, "Server shutting down");
      await this.agents.cancel(sessionId, "Server shutting down").catch(() => undefined);
    }
    await Promise.race([
      Promise.all(active.map(([, run]) => run.promise)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    for (const [jobId, job] of [...this.queued]) {
      this.queued.delete(jobId);
      this.repos.jobs.markFinished(jobId, "interrupted", new Date().toISOString(), {
        error: "Server shut down before the job started",
      });
      this.events.append({
        sessionId: job.sessionId,
        jobId,
        type: "job.finished",
        payload: { status: "interrupted", error: "Server shut down before the job started" },
      });
    }
    await this.agents.disposeAll();
  }

  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (this.running < this.config.limits.globalConcurrency) {
        const job = this.pickNext();
        if (!job) break;
      }
    } finally {
      this.pumping = false;
    }
  }

  private pickNext(): JobRecord | undefined {
    const jobs = [...this.queued.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const job of jobs) {
      if (this.active.has(job.sessionId)) continue;
      const session = this.repos.sessions.byId(job.sessionId);
      if (!session) {
        this.queued.delete(job.id);
        this.repos.jobs.markFinished(job.id, "failed", new Date().toISOString(), {
          error: "Session no longer exists",
        });
        continue;
      }
      const project = this.repos.projects.byId(session.projectId);
      if (!project) {
        this.queued.delete(job.id);
        this.repos.jobs.markFinished(job.id, "failed", new Date().toISOString(), {
          error: "Project no longer exists",
        });
        continue;
      }
      const lock = this.lockKey(session, project);
      if (this.workspaceLocks.has(lock)) continue;
      this.workspaceLocks.set(lock, session.id);
      this.queued.delete(job.id);
      this.running += 1;
      const run: ActiveRun = { jobId: job.id, promise: Promise.resolve() };
      this.active.set(session.id, run);
      run.promise = this.execute(job, session, project)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(session.id);
          this.workspaceLocks.delete(lock);
          this.running -= 1;
          this.cancelled.delete(job.id);
          this.interruptReasons.delete(job.id);
          this.pump();
        });
      return job;
    }
    return undefined;
  }

  private async execute(job: JobRecord, session: SessionRecord, project: ProjectRecord): Promise<void> {
    const now = new Date().toISOString();
    this.repos.jobs.markStarted(job.id, now);
    this.setSessionStatus(session, "running");
    this.events.append({
      sessionId: session.id,
      jobId: job.id,
      type: "job.started",
      payload: { requestedBy: job.requestedBy },
    });
    try {
      await this.workspace.ensure(session, project);
      const stopReason = await this.agents.prompt(session, job.id, job.prompt);
      if (this.cancelled.has(job.id) || this.stopAfter.has(session.id)) {
        this.finishCancelled(job, session, stopReason);
        return;
      }
      const status = stopReason === "cancelled" ? "cancelled" : "completed";
      this.repos.jobs.markFinished(job.id, status, new Date().toISOString(), { stopReason });
      this.setSessionStatus(session, status);
      this.events.append({
        sessionId: session.id,
        jobId: job.id,
        type: "job.finished",
        payload: { status, stopReason },
      });
    } catch (error) {
      const reason = this.interruptReasons.get(job.id);
      if (reason) {
        this.repos.jobs.markFinished(job.id, "interrupted", new Date().toISOString(), { error: reason });
        this.setSessionStatus(session, "interrupted");
        this.events.append({
          sessionId: session.id,
          jobId: job.id,
          type: "job.finished",
          payload: { status: "interrupted", error: reason },
        });
        return;
      }
      if (this.cancelled.has(job.id)) {
        this.finishCancelled(job, session);
        return;
      }
      if (error instanceof AcpTimeoutError) {
        this.repos.jobs.markFinished(job.id, "cancelled", new Date().toISOString(), {
          error: error.message,
        });
        this.setSessionStatus(session, "cancelled");
        this.events.append({
          sessionId: session.id,
          jobId: job.id,
          type: "job.finished",
          payload: { status: "cancelled", error: error.message },
        });
        return;
      }
      const message = this.redact(error instanceof Error ? error.message : String(error));
      this.repos.jobs.markFinished(job.id, "failed", new Date().toISOString(), { error: message });
      this.setSessionStatus(session, error instanceof AcpAuthRequiredError ? "failed" : "failed");
      this.events.append({
        sessionId: session.id,
        jobId: job.id,
        type: "session.error",
        payload: { message },
      });
      this.events.append({
        sessionId: session.id,
        jobId: job.id,
        type: "job.finished",
        payload: { status: "failed", error: message },
      });
    } finally {
      this.agents.clearJob(session.id);
      if (this.stopAfter.has(session.id)) {
        this.stopAfter.delete(session.id);
        await this.agents.stop(session.id).catch(() => undefined);
      }
    }
  }

  private finishCancelled(job: JobRecord, session: SessionRecord, stopReason?: string): void {
    this.repos.jobs.markFinished(job.id, "cancelled", new Date().toISOString(), {
      stopReason,
      error: "Cancelled",
    });
    this.setSessionStatus(session, "cancelled");
    this.events.append({
      sessionId: session.id,
      jobId: job.id,
      type: "job.finished",
      payload: { status: "cancelled", stopReason, error: "Cancelled" },
    });
  }

  private setSessionStatus(session: SessionRecord, status: SessionStatus): void {
    if (session.status === status) return;
    const previous = session.status;
    this.repos.sessions.updateStatus(session.id, status, new Date().toISOString());
    session.status = status;
    this.events.append({
      sessionId: session.id,
      type: "session.status",
      payload: { status, previousStatus: previous },
    });
  }

  private lockKey(session: SessionRecord, project: ProjectRecord): string {
    if (project.localPath && session.workspacePath === project.localPath) {
      return `path:${project.localPath}`;
    }
    return `session:${session.id}`;
  }

  private redact(value: string): string {
    return truncateUtf8(value, 8_000).text.replace(
      /xox[abposr]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+/g,
      "[REDACTED]",
    );
  }
}
