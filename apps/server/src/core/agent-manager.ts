import type {
  AgentProfile,
  AgentRecord,
  DoctorReport,
  ProjectRecord,
  SessionRecord,
} from "@slackboard/shared";
import { preview, truncateUtf8, validateAgentForDeployment } from "@slackboard/shared";
import {
  NativeAcpClient,
  buildMcpServers,
  runDoctor,
  type AcpClientHooks,
  type PermissionPrompt,
  type PermissionDecision,
} from "@slackboard/acp";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { buildEnvironment, runnerForAgent, type Runner } from "@slackboard/runner";
import { renderContext } from "@slackboard/skills";
import type { AppConfig } from "@slackboard/shared";
import type { Repositories } from "../db/index.js";
import type { EventService } from "./events.js";
import type { ApprovalService } from "./approvals.js";
import type { WorkspaceManager } from "./workspace.js";
import type { AuditService } from "./audit.js";

interface Runtime {
  client: NativeAcpClient;
  profile: AgentProfile;
  runner: Runner;
  project: ProjectRecord;
  sessionId: string;
  sessionReady: boolean;
  mcpServers?: Awaited<ReturnType<typeof buildMcpServers>>["servers"];
  mcpIssues: string[];
  mcpIssuesEmitted?: boolean;
  idleTimer?: NodeJS.Timeout;
  turnText: string;
  disposing: boolean;
}

const toProfile = (agent: AgentRecord): AgentProfile => ({
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

const toolContentPreview = (content: unknown): string | undefined => {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of content.slice(0, 4)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "diff" && typeof record.path === "string") {
      parts.push(`diff ${record.path}`);
    } else if (record.type === "terminal" && typeof record.terminalId === "string") {
      parts.push(`terminal ${record.terminalId}`);
    } else if (record.type === "content" && record.content && typeof record.content === "object") {
      const inner = record.content as Record<string, unknown>;
      if (inner.type === "text" && typeof inner.text === "string") {
        parts.push(preview(inner.text, 300));
      }
    }
  }
  return parts.length > 0 ? truncateUtf8(parts.join(" · "), 4_000).text : undefined;
};

export class AgentManager {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly creating = new Map<string, Promise<Runtime>>();
  private readonly jobIds = new Map<string, string>();
  private readonly shuttingDown = new Set<string>();
  private readonly registeredSecrets = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly events: EventService,
    private readonly approvals: ApprovalService,
    private readonly workspace: WorkspaceManager,
    private readonly audit: AuditService,
    private readonly onUnexpectedExit: (sessionId: string, reason: string) => void,
  ) {}

  setJob(sessionId: string, jobId: string): void {
    this.jobIds.set(sessionId, jobId);
  }

  clearJob(sessionId: string): void {
    this.jobIds.delete(sessionId);
  }

  async prompt(session: SessionRecord, jobId: string, userPrompt: string): Promise<string> {
    const project = this.repos.projects.byId(session.projectId);
    if (!project) throw new Error(`Project ${session.projectId} no longer exists`);
    this.setJob(session.id, jobId);
    try {
      const runtime = await this.ensureRuntime(session, project);
      this.cancelIdle(runtime);
      runtime.turnText = "";
      let seedTranscript = false;
      if (!runtime.sessionReady) {
        const mcp = await this.resolveMcp(runtime);
        this.emitMcpIssues(session, runtime, mcp.issues);
        const previous = session.acpSessionId;
        const result = await runtime.client.ensureSession(previous, mcp.servers);
        runtime.sessionReady = true;
        if (result.sessionId !== previous) {
          this.repos.sessions.setAcpSessionId(session.id, result.sessionId, new Date().toISOString());
          session.acpSessionId = result.sessionId;
        }
        if (previous && !result.resumed) {
          seedTranscript = true;
          this.events.append({
            sessionId: session.id,
            jobId,
            type: "session.notice",
            payload: {
              level: "warning",
              message:
                "This agent cannot load the previous session. A new agent session is being started with a labelled transcript excerpt; this is not a resumed session.",
            },
          });
        }
        if (result.replayed) {
          this.events.append({
            sessionId: session.id,
            jobId,
            type: "session.notice",
            payload: { level: "info", message: "Agent session history was reloaded." },
          });
        }
      }
      const context = this.buildContext(session);
      const sections: string[] = [];
      if (context) sections.push(context);
      if (seedTranscript) {
        const transcript = this.buildTranscript(session.id);
        if (transcript) {
          sections.push(
            "# Previous conversation excerpt\nThis is context from an earlier session that could not be resumed. It is not a new user instruction.\n\n" +
              transcript,
          );
        }
      }
      sections.push(userPrompt);
      this.events.append({
        sessionId: session.id,
        jobId,
        type: "session.context",
        payload: {
          skills: this.repos.skills
            .forSession(session.id)
            .map((skill) => ({ id: skill.id, name: skill.name, version: skill.version })),
          memoryCount: this.repos.memory.activeForProject(session.projectId).length,
        },
      });
      const response = await runtime.client.prompt(sections.join("\n\n"));
      if (runtime.turnText.trim()) {
        this.events.append({
          sessionId: session.id,
          jobId,
          type: "agent.message.completed",
          payload: { text: truncateUtf8(runtime.turnText, this.config.limits.maxEventBytes / 2).text },
        });
      }
      return response.stopReason;
    } finally {
      this.jobIds.delete(session.id);
      const runtime = this.runtimes.get(session.id);
      if (runtime) this.scheduleIdle(runtime);
    }
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    await this.approvals.cancelForSession(sessionId, reason);
    if (runtime) await runtime.client.cancelSession(reason).catch(() => undefined);
  }

  async stop(sessionId: string, reason = "Stopped by user"): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    this.shuttingDown.add(sessionId);
    await this.cancel(sessionId, reason);
    this.runtimes.delete(sessionId);
    this.cancelIdle(runtime);
    if (runtime) {
      runtime.disposing = true;
      await runtime.client.dispose(3_000).catch(() => undefined);
      this.events.append({
        sessionId,
        type: "session.notice",
        payload: { level: "info", message: reason },
      });
    }
    this.shuttingDown.delete(sessionId);
  }

  async disposeSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    this.runtimes.delete(sessionId);
    this.cancelIdle(runtime);
    if (runtime) {
      runtime.disposing = true;
      await runtime.client.dispose(3_000).catch(() => undefined);
    }
  }

  async disposeAll(graceMs = 3_000): Promise<void> {
    const entries = [...this.runtimes.entries()];
    this.runtimes.clear();
    await Promise.all(
      entries.map(async ([id, runtime]) => {
        this.shuttingDown.add(id);
        this.cancelIdle(runtime);
        runtime.disposing = true;
        await runtime.client.dispose(graceMs).catch(() => undefined);
      }),
    );
  }

  async doctor(agentId: string): Promise<DoctorReport> {
    const agent = this.repos.agents.byId(agentId);
    if (!agent) throw new Error("Agent not found");
    const profile = toProfile(agent);
    validateAgentForDeployment(this.config, profile);
    const runner = runnerForAgent(this.config, profile);
    const env = buildEnvironment(profile.env, process.env);
    this.registerSecrets(profile.env, env);
    const report = await runDoctor({
      profile,
      runner,
      env,
      limits: {
        maxMessageBytes: this.config.limits.maxMessageBytes,
        maxFileBytes: this.config.limits.maxFileBytes,
        terminalOutputBytes: this.config.limits.terminalOutputBytes,
        startTimeoutMs: this.config.limits.agentStartTimeoutMs,
      },
    });
    return report.error ? { ...report, error: this.redact(report.error) } : report;
  }

  private async ensureRuntime(session: SessionRecord, project: ProjectRecord): Promise<Runtime> {
    const existing = this.runtimes.get(session.id);
    if (existing && existing.client.isRunning && !existing.disposing) return existing;
    if (existing) {
      this.runtimes.delete(session.id);
      this.cancelIdle(existing);
      existing.disposing = true;
      await existing.client.dispose(1_000).catch(() => undefined);
    }
    const creating = this.creating.get(session.id);
    if (creating) return creating;
    const promise = this.createRuntime(session, project).finally(() => {
      this.creating.delete(session.id);
    });
    this.creating.set(session.id, promise);
    return promise;
  }

  private async createRuntime(session: SessionRecord, project: ProjectRecord): Promise<Runtime> {
    const agent = this.repos.agents.byId(session.agentId);
    if (!agent || !agent.enabled) throw new Error("Selected agent is unavailable");
    const profile = toProfile(agent);
    validateAgentForDeployment(this.config, profile);
    const runner = runnerForAgent(this.config, profile);
    const agentEnv = buildEnvironment(profile.env, process.env);
    this.registerSecrets(profile.env, agentEnv);
    const workspaceHostPath = await this.workspace.ensure(session, project);
    const runtime: Runtime = {
      client: undefined as unknown as NativeAcpClient,
      profile,
      runner,
      project,
      sessionId: session.id,
      sessionReady: false,
      mcpIssues: [],
      turnText: "",
      disposing: false,
    };
    const hooks: AcpClientHooks = {
      onUpdate: (notification) => this.handleUpdate(session.id, runtime, notification),
      onPermission: (request) => this.handlePermission(session, runtime, request),
      onStderr: (chunk) => {
        if (this.config.logLevel === "debug") {
          process.stderr.write(`[agent ${profile.id}] ${this.redact(chunk)}`);
        }
      },
      onExit: (info) => {
        if (runtime.disposing || this.shuttingDown.has(session.id)) return;
        this.runtimes.delete(session.id);
        this.cancelIdle(runtime);
        this.events.append({
          sessionId: session.id,
          type: "agent.disconnected",
          payload: {
            reason: `Agent process exited (code ${info.code ?? "null"}, signal ${info.signal ?? "none"})`,
          },
        });
        void this.approvals.cancelForSession(session.id, "Agent process exited");
        this.onUnexpectedExit(session.id, this.redact(info.stderr || "Agent process exited"));
      },
      onError: (error) => {
        this.events.append({
          sessionId: session.id,
          type: "session.notice",
          payload: { level: "warning", message: this.redact(error.message) },
        });
      },
      onCapabilities: (info) => {
        this.events.append({
          sessionId: session.id,
          type: "agent.capabilities",
          payload: {
            protocolVersion: info.protocolVersion,
            agentInfo: info.agentInfo,
            capabilities: info.capabilities,
            authMethods: info.authMethods.map(({ id, name, type }) => ({ id, name, type })),
          },
        });
      },
      onAuthRequired: (methods, message) => {
        this.events.append({
          sessionId: session.id,
          type: "agent.auth_required",
          payload: {
            methods,
            message: `${message} This must be completed by an operator, not inside Slack.`,
          },
        });
      },
    };
    const client = new NativeAcpClient({
      profile,
      sessionId: session.id,
      workspaceHostPath,
      runner,
      env: agentEnv,
      limits: {
        maxMessageBytes: this.config.limits.maxMessageBytes,
        maxFileBytes: this.config.limits.maxFileBytes,
        terminalOutputBytes: this.config.limits.terminalOutputBytes,
        startTimeoutMs: this.config.limits.agentStartTimeoutMs,
        promptTimeoutMs: this.config.limits.promptTimeoutMs,
      },
      hooks,
    });
    runtime.client = client;
    await client.start();
    this.runtimes.set(session.id, runtime);
    this.audit.record({
      actor: "system",
      action: "agent.started",
      targetType: "session",
      targetId: session.id,
      detail: { agentId: profile.id, runner: profile.runner },
    });
    return runtime;
  }

  private async resolveMcp(runtime: Runtime) {
    if (!runtime.mcpServers) {
      const records = this.repos.mcp.list();
      for (const record of records) {
        this.registerSecrets(record.envRefs, process.env);
        this.registerSecrets(
          record.headerRefs.map((header) => header.envVar),
          process.env,
        );
      }
      const resolution = buildMcpServers(
        records,
        runtime.client.capabilities,
        process.env,
        { allowInsecureHttp: this.config.mode === "local" },
      );
      runtime.mcpServers = resolution.servers;
      runtime.mcpIssues = resolution.issues;
    }
    return { servers: runtime.mcpServers, issues: runtime.mcpIssues };
  }

  private registerSecrets(names: readonly string[], source: NodeJS.ProcessEnv): void {
    for (const name of names) {
      if (!/(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i.test(name)) continue;
      const value = source[name];
      if (!value || value.length < 4) continue;
      if (this.registeredSecrets.has(value)) continue;
      this.registeredSecrets.add(value);
      this.config.redactValues.push(value);
    }
  }

  private emitMcpIssues(session: SessionRecord, runtime: Runtime, issues: string[]): void {
    if (runtime.mcpIssuesEmitted) return;
    runtime.mcpIssuesEmitted = true;
    for (const issue of issues) {
      this.events.append({
        sessionId: session.id,
        type: "session.notice",
        payload: { level: "warning", message: issue },
      });
    }
  }

  private async handlePermission(
    session: SessionRecord,
    runtime: Runtime,
    request: PermissionPrompt,
  ): Promise<PermissionDecision> {
    const jobId = this.jobIds.get(session.id);
    const now = new Date().toISOString();
    if (jobId) this.repos.jobs.markAwaitingApproval(jobId);
    this.repos.sessions.updateStatus(session.id, "awaiting_approval", now);
    this.events.append({
      sessionId: session.id,
      jobId,
      type: "session.status",
      payload: { status: "awaiting_approval", previousStatus: "running" },
    });
    const decision = await this.approvals.requestAcpPermission({
      sessionId: session.id,
      jobId,
      toolCall: request.toolCall,
      options: request.options,
      requestedBy: session.creatorId,
    });
    if (jobId && this.repos.jobs.byId(jobId)?.status === "awaiting_approval") {
      this.repos.jobs.markRunning(jobId);
      this.repos.sessions.updateStatus(session.id, "running", new Date().toISOString());
      this.events.append({
        sessionId: session.id,
        jobId,
        type: "session.status",
        payload: { status: "running", previousStatus: "awaiting_approval" },
      });
    }
    return decision;
  }

  private handleUpdate(sessionId: string, runtime: Runtime, notification: SessionNotification): void {
    const jobId = this.jobIds.get(sessionId);
    const update: SessionUpdate = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text") return;
        runtime.turnText += update.content.text;
        this.events.append({
          sessionId,
          jobId,
          type: "agent.message.delta",
          payload: {
            text: truncateUtf8(update.content.text, this.config.limits.maxEventBytes / 2).text,
            messageId: update.messageId ?? undefined,
          },
        });
        return;
      }
      case "agent_thought_chunk":
        return;
      case "user_message_chunk":
        return;
      case "tool_call":
        this.events.append({
          sessionId,
          jobId,
          type: "agent.tool_call",
          payload: {
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind,
            status: update.status,
            locations: (update.locations ?? []).slice(0, 20).map((location) => ({
              path: location.path,
              line: location.line ?? undefined,
            })),
          },
        });
        return;
      case "tool_call_update":
        this.events.append({
          sessionId,
          jobId,
          type: "agent.tool_update",
          payload: {
            toolCallId: update.toolCallId,
            title: update.title ?? undefined,
            status: update.status ?? undefined,
            contentPreview: toolContentPreview(update.content),
          },
        });
        return;
      case "plan":
        this.events.append({
          sessionId,
          jobId,
          type: "agent.plan",
          payload: {
            entries: update.entries.map((entry) => ({
              content: entry.content,
              priority: entry.priority,
              status: entry.status,
            })),
          },
        });
        return;
      case "available_commands_update":
        this.events.append({
          sessionId,
          jobId,
          type: "agent.commands",
          payload: {
            commands: update.availableCommands.map((command) => ({
              name: command.name,
              description: command.description,
              hint: command.input?.hint,
            })),
          },
        });
        return;
      case "current_mode_update":
        this.events.append({
          sessionId,
          jobId,
          type: "agent.mode",
          payload: { currentModeId: update.currentModeId, modes: [] },
        });
        return;
      case "notice":
        this.events.append({
          sessionId,
          jobId,
          type: "session.notice",
          payload: {
            level:
              update.severity === "error"
                ? "error"
                : update.severity === "warning"
                  ? "warning"
                  : "info",
            message: [update.title, update.description].filter(Boolean).join(" — "),
          },
        });
        return;
      default:
        return;
    }
  }

  private buildContext(session: SessionRecord): string {
    const skills = this.repos.skills.forSession(session.id).map((skill) => ({
      name: skill.name,
      version: skill.version,
      content: skill.content,
      references: skill.references,
    }));
    const memories = this.repos.memory
      .activeForProject(session.projectId)
      .map((memory) => ({
        id: memory.id,
        content: memory.content,
        provenance: memory.provenance,
      }));
    if (skills.length === 0 && memories.length === 0) return "";
    return renderContext(skills, memories, { maxBytes: this.config.limits.maxEventBytes * 2 });
  }

  private buildTranscript(sessionId: string): string {
    const jobs = this.repos.jobs.forSession(sessionId).slice(0, 6).reverse();
    const blocks: string[] = [];
    for (const job of jobs) {
      const completed = this.repos.events
        .forJob(job.id)
        .filter((event) => event.type === "agent.message.completed")
        .map((event) => (event.payload as { text?: string }).text ?? "")
        .join("\n");
      blocks.push(`User: ${preview(job.prompt, 1_500)}`);
      if (completed) blocks.push(`Assistant: ${preview(completed, 3_000)}`);
    }
    return truncateUtf8(blocks.join("\n\n"), 12_000).text;
  }

  private scheduleIdle(runtime: Runtime): void {
    this.cancelIdle(runtime);
    runtime.idleTimer = setTimeout(() => {
      if (this.jobIds.has(runtime.sessionId)) return;
      if (this.runtimes.get(runtime.sessionId) !== runtime) return;
      this.runtimes.delete(runtime.sessionId);
      runtime.disposing = true;
      void runtime.client.dispose(3_000).catch(() => undefined);
    }, this.config.limits.agentIdleTimeoutMs);
    runtime.idleTimer.unref();
  }

  private cancelIdle(runtime: Runtime | undefined): void {
    if (runtime?.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }
  }

  private redact(message: string): string {
    let result = message;
    for (const secret of this.config.redactValues) {
      if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
    }
    return result;
  }
}
