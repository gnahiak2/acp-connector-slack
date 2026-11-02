import type {
  AgentRecord,
  AppConfig,
  ProjectRecord,
  SessionRecord,
  SessionSummary,
} from "@slackboard/shared";
import { newId, preview, validateAgentForDeployment } from "@slackboard/shared";
import type { Repositories } from "../db/index.js";
import type { EventService } from "./events.js";
import type { AccessService, Actor } from "./access.js";
import type { WorkspaceManager } from "./workspace.js";
import type { JobQueue } from "./jobs.js";
import type { AuditService } from "./audit.js";

export class SessionNotFoundError extends Error {}
export class SessionForbiddenError extends Error {}
export class SessionValidationError extends Error {}
export class SetupRequiredError extends Error {}

export interface CreateSessionInput {
  origin: "slack" | "dashboard";
  creatorId: string;
  projectId?: string;
  agentId?: string;
  title?: string;
  teamId?: string;
  channelId?: string;
  threadTs?: string;
}

export class SessionService {
  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly events: EventService,
    private readonly access: AccessService,
    private readonly workspace: WorkspaceManager,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const project = input.projectId
      ? this.repos.projects.byId(input.projectId)
      : this.defaultProject();
    if (!project) {
      throw input.projectId
        ? new SessionValidationError("Project not found")
        : new SetupRequiredError("No project is configured. Create one in the dashboard.");
    }
    if (project.archivedAt) throw new SessionValidationError("Project is archived");
    const agent = input.agentId ? this.repos.agents.byId(input.agentId) : this.defaultAgent();
    if (!agent) {
      throw input.agentId
        ? new SessionValidationError("Agent not found")
        : new SetupRequiredError("No agent is configured. Add one in the dashboard.");
    }
    if (!agent.enabled) throw new SessionValidationError("Agent is disabled");
    validateAgentForDeployment(this.config, {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      executable: agent.executable,
      args: agent.args,
      env: agent.env,
      runner: agent.runner,
      authentication: agent.authentication,
      enabled: agent.enabled,
      preset: agent.preset,
    });
    if (input.origin === "slack") {
      if (!input.teamId || !input.channelId || !input.threadTs) {
        throw new SessionValidationError("Slack sessions require team, channel and thread");
      }
      const existing = this.repos.sessions.byThread(input.teamId, input.channelId, input.threadTs);
      if (existing) return existing;
      const isDirectMessage = input.channelId.startsWith("D");
      if (!isDirectMessage && !this.access.slackChannelAllowed(input.channelId)) {
        throw new SessionForbiddenError("This channel is not allowed");
      }
      if (!this.access.slackUserAllowed(input.creatorId)) {
        throw new SessionForbiddenError("This user is not allowed");
      }
      if (!isDirectMessage && !this.access.projectAllowedForChannel(project, input.channelId)) {
        throw new SessionForbiddenError("This project is not available in this channel");
      }
    }
    const id = newId("ses");
    const workspacePath = await this.workspace.workspacePathFor(project, id);
    const allowedUsers =
      input.origin === "slack" && !this.config.slack.allowedUsers.includes("*")
        ? this.config.slack.allowedUsers
        : [];
    const title = (input.title?.trim() || `Session ${new Date().toISOString().slice(0, 16)}`).slice(
      0,
      200,
    );
    const session = this.repos.sessions.create(
      {
        id,
        origin: input.origin,
        teamId: input.teamId,
        channelId: input.channelId,
        threadTs: input.threadTs,
        projectId: project.id,
        agentId: agent.id,
        creatorId: input.creatorId,
        title,
        workspacePath,
        accessPolicy: {
          userIds: allowedUsers,
          channelId: input.origin === "slack" ? input.channelId : undefined,
        },
      },
      new Date().toISOString(),
    );
    this.events.append({
      sessionId: session.id,
      type: "session.created",
      payload: {
        title: session.title,
        agentId: agent.id,
        projectId: project.id,
        origin: session.origin,
      },
    });
    this.audit.record({
      actor: input.creatorId,
      action: "session.created",
      targetType: "session",
      targetId: session.id,
      detail: {
        origin: input.origin,
        projectId: project.id,
        agentId: agent.id,
        channelId: input.channelId,
      },
    });
    return session;
  }

  get(id: string): SessionRecord | undefined {
    return this.repos.sessions.byId(id);
  }

  getForActor(id: string, actor: Actor): SessionRecord {
    const session = this.repos.sessions.byId(id);
    if (!session) throw new SessionNotFoundError("Session not found");
    if (!this.access.sessionAllowed(session, actor)) {
      throw new SessionForbiddenError("Not authorised for this session");
    }
    return session;
  }

  summaryForActor(id: string, actor: Actor): SessionSummary {
    const session = this.getForActor(id, actor);
    const summary = this.repos.sessions.summaryById(session.id);
    if (!summary) throw new SessionNotFoundError("Session not found");
    return summary;
  }

  list(): SessionSummary[] {
    return this.repos.sessions.list({ limit: 200 });
  }

  findByThread(teamId: string, channelId: string, threadTs: string): SessionRecord | undefined {
    return this.repos.sessions.byThread(teamId, channelId, threadTs);
  }

  latestForChannel(channelId: string): SessionRecord | undefined {
    return this.repos.sessions.latestForChannel(channelId);
  }

  async createSlackSession(input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    creatorId: string;
    title?: string;
    agentId?: string;
    projectId?: string;
  }): Promise<SessionRecord> {
    const defaults = this.repos.slack.channelDefaults(input.channelId);
    const agentId =
      input.agentId ??
      defaults?.agentId ??
      this.config.slack.defaultAgentId ??
      this.defaultAgent()?.id;
    const projectId =
      input.projectId ??
      defaults?.projectId ??
      this.config.slack.defaultProjectId ??
      this.defaultProject()?.id;
    return this.create({ ...input, origin: "slack", agentId, projectId });
  }

  async prompt(
    session: SessionRecord,
    actor: Actor,
    text: string,
    dedupeKey?: string,
  ): Promise<{ jobId: string; duplicate: boolean }> {
    if (!this.access.sessionAllowed(session, actor)) {
      throw new SessionForbiddenError("Not authorised for this session");
    }
    const { job, duplicate } = this.queue.enqueue({
      sessionId: session.id,
      prompt: text,
      requestedBy: actor.id,
      dedupeKey,
    });
    return { jobId: job.id, duplicate };
  }

  setChannelDefaults(channelId: string, input: { agentId?: string; projectId?: string }): void {
    if (input.agentId) {
      const agent = this.repos.agents.byId(input.agentId);
      if (!agent?.enabled) throw new SessionValidationError("Agent is unavailable");
    }
    if (input.projectId) {
      const project = this.repos.projects.byId(input.projectId);
      if (!project || project.archivedAt) throw new SessionValidationError("Project is unavailable");
    }
    this.repos.slack.setChannelDefaults(channelId, input, new Date().toISOString());
  }

  channelDefaults(channelId: string): { agentId?: string; projectId?: string } | undefined {
    return this.repos.slack.channelDefaults(channelId);
  }

  setTitle(session: SessionRecord, title: string, actor: string): void {
    const clean = title.trim().slice(0, 200);
    if (!clean) throw new SessionValidationError("Title is empty");
    this.repos.sessions.setTitle(session.id, clean, new Date().toISOString());
    this.audit.record({
      actor,
      action: "session.renamed",
      targetType: "session",
      targetId: session.id,
      detail: { title: clean },
    });
  }

  defaultProject(): ProjectRecord | undefined {
    return this.repos.projects.list().find((project) => !project.archivedAt);
  }

  defaultAgent(): AgentRecord | undefined {
    return this.repos.agents.list(false).find((agent) => agent.enabled);
  }

  describe(session: SessionRecord): string {
    return preview(session.title, 100);
  }
}
