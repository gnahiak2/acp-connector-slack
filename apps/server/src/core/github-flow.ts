import type { ApprovalRecord, AppConfig, SessionRecord } from "@slackboard/shared";
import type { GithubService } from "@slackboard/integrations";
import type { Repositories } from "../db/index.js";
import type { EventService } from "./events.js";
import type { WorkspaceManager } from "./workspace.js";
import type { ApprovalService } from "./approvals.js";
import type { AuditService } from "./audit.js";
import type { AccessService, Actor } from "./access.js";

export class GithubFlowError extends Error {}

export interface PullRequestRequest {
  sessionId: string;
  repository?: string;
  title: string;
  body: string;
  base?: string;
  head?: string;
}

export class GithubFlow {
  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly events: EventService,
    private readonly workspace: WorkspaceManager,
    private readonly approvals: ApprovalService,
    private readonly access: AccessService,
    private readonly github: GithubService,
    private readonly audit: AuditService,
  ) {}

  register(): void {
    this.approvals.registerHandler("github_push", (approval) => this.perform(approval));
  }

  requestPullRequest(
    session: SessionRecord,
    actor: Actor,
    input: PullRequestRequest,
  ): ApprovalRecord {
    if (!this.github.configured) throw new GithubFlowError("GitHub App integration is not configured");
    if (input.title.trim().length === 0 || input.title.length > 200) {
      throw new GithubFlowError("Pull request title is required (max 200 characters)");
    }
    if (input.body.length > 20_000) throw new GithubFlowError("Pull request body is too long");
    const project = this.repos.projects.byId(session.projectId);
    if (!project) throw new GithubFlowError("Project not found");
    if (!this.access.sessionAllowed(session, actor)) {
      throw new GithubFlowError("Not authorised for this session");
    }
    const repository = input.repository ?? project.repository;
    if (!repository) throw new GithubFlowError("Project has no GitHub repository");
    const head =
      input.head?.trim() ||
      `slackboard/session-${session.id.slice(-12)}-${Date.now().toString(36)}`;
    const base = input.base?.trim() || project.defaultBranch;
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(head) || head.includes("..")) {
      throw new GithubFlowError("Invalid head branch");
    }
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(base) || base.includes("..")) {
      throw new GithubFlowError("Invalid base branch");
    }
    return this.approvals.requestGithubApproval({
      sessionId: session.id,
      requestedBy: actor.id,
      title: `Create draft PR: ${input.title.trim()}`,
      details: {
        projectId: project.id,
        repository,
        base,
        head,
        title: input.title.trim(),
        body: input.body.trim(),
      },
    });
  }

  private async perform(approval: ApprovalRecord): Promise<Record<string, unknown>> {
    const details = approval.details as {
      projectId?: string;
      repository?: string;
      base?: string;
      head?: string;
      title?: string;
      body?: string;
    };
    if (!details.repository || !details.base || !details.head || !details.title) {
      throw new GithubFlowError("Approval payload is incomplete");
    }
    const session = this.repos.sessions.byId(approval.sessionId);
    if (!session) throw new GithubFlowError("Session not found");
    const project = this.repos.projects.byId(details.projectId ?? session.projectId);
    if (!project) throw new GithubFlowError("Project not found");
    await this.workspace.ensure(session, project);
    await this.github.assertAllowedRepo(details.repository);
    const files = await this.workspace.changedFiles(session);
    if (files.length === 0) throw new GithubFlowError("Workspace has no changed files to publish");
    try {
      await this.github.createBranch(details.repository, details.head, details.base);
    } catch (error) {
      if (!/already exists|Reference already exists/i.test((error as Error).message)) throw error;
    }
    await this.github.commitFiles(
      details.repository,
      details.head,
      files,
      `Slackboard: ${details.title}\n\nApproved by ${approval.resolvedBy ?? "an authorised member"}.`,
    );
    const pull = await this.github.createDraftPullRequest(details.repository, {
      title: details.title,
      body: details.body ?? "",
      head: details.head,
      base: details.base,
    });
    this.events.append({
      sessionId: session.id,
      jobId: approval.jobId,
      type: "github.approval.completed",
      payload: {
        approvalId: approval.id,
        pullRequestUrl: pull.url,
        number: pull.number,
      },
    });
    this.audit.record({
      actor: approval.resolvedBy ?? "system",
      action: "github.pull_request.created",
      targetType: "session",
      targetId: session.id,
      detail: {
        repository: details.repository,
        head: details.head,
        base: details.base,
        number: pull.number,
      },
    });
    return { pullRequestUrl: pull.url, number: pull.number };
  }
}
